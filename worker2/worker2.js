// worker2.js
// 独立兜底 Worker：通过 tongyi 自身的状态 API 检查心跳，不再依赖 Cloudflare 账号级 API

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function beijingHHMM() {
  const d = beijingNow();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function beijingHMS() {
  const d = beijingNow();
  return [
    String(d.getUTCHours()).padStart(2, "0"),
    String(d.getUTCMinutes()).padStart(2, "0"),
    String(d.getUTCSeconds()).padStart(2, "0"),
  ].join(":");
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseTimeToSeconds(text) {
  const match = String(text || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const second = parseInt(match[3] || "0", 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }

  return hour * 3600 + minute * 60 + second;
}

function shouldTriggerSchoolNow(school) {
  const nowHHMM = beijingHHMM();
  const nowHMS = beijingHMS();
  const triggerTime = String(school?.trigger_time || "").trim();
  const endtime = String(school?.endtime || "").trim();

  if (!triggerTime) return false;
  if (nowHHMM < triggerTime) return false;

  if (!endtime) return true;

  const nowSeconds = parseTimeToSeconds(nowHMS);
  const endSeconds = parseTimeToSeconds(endtime);
  if (nowSeconds === null || endSeconds === null) return true;

  return nowSeconds <= endSeconds;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { raw: text };
  }

  if (!res.ok) {
    const detail = typeof data?.error === "string" ? data.error : text || `HTTP ${res.status}`;
    throw new Error(`${url} -> HTTP ${res.status}: ${detail}`);
  }

  return data;
}

async function getWorker1Status(env) {
  return fetchJson(`${env.TRIGGER_API}/status`, {
    headers: { "X-API-Key": env.API_KEY },
  });
}

async function getSchools(env) {
  const data = await fetchJson(`${env.TRIGGER_API}/schools`, {
    headers: { "X-API-Key": env.API_KEY },
  });
  return data.schools || [];
}

async function triggerSchool(env, schoolId, options = {}) {
  const headers = { "X-API-Key": env.API_KEY };
  if (options.triggerSource) headers["X-Trigger-Source"] = options.triggerSource;
  if (options.fallbackMode) headers["X-Fallback-Mode"] = options.fallbackMode;

  return fetchJson(`${env.TRIGGER_API}/trigger/${schoolId}`, {
    method: "POST",
    headers,
  });
}

async function sendFeishuText(env, msg) {
  const webhook = String(env.FEISHU_WEBHOOK || "").trim();
  if (!webhook) {
    return {
      ok: false,
      skipped: true,
      reason: "webhook_missing",
    };
  }
  const keyword = String(env.FEISHU_KEYWORD || "检测").trim() || "检测";
  const text = String(msg || "").includes(keyword)
    ? String(msg || "")
    : `${keyword}\n${String(msg || "")}`;

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
    const detail = (await response.text()).trim();
    const result = {
      ok: response.ok,
      status: response.status,
      detail: detail.slice(0, 300),
    };
    console.log("Feishu send result:", JSON.stringify(result));
    return result;
  } catch (e) {
    const result = {
      ok: false,
      error: e.message || String(e),
    };
    console.log("Feishu send error:", JSON.stringify(result));
    return result;
  }
}

async function sendFeishuAlerts(env, messages) {
  const normalized = (messages || [])
    .map(msg => String(msg || "").trim())
    .filter(Boolean);

  if (normalized.length === 0) return [];

  const results = [];
  for (let i = 0; i < normalized.length; i++) {
    const prefix = normalized.length > 1 ? `[${i + 1}/${normalized.length}]\n` : "";
    results.push(await sendFeishuText(env, prefix + normalized[i]));
  }
  return results;
}

function summarizeTriggered(results) {
  const ok = results.filter(r => r.ok && !r.skipped).length;
  const skipped = results.filter(r => r.ok && r.skipped).length;
  return {
    ok,
    skipped,
    fail: results.filter(r => !r.ok).length,
  };
}

function chunkLines(lines, maxChars = 900) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    const nextLen = currentLen + (current.length ? 1 : 0) + line.length;
    if (current.length && nextLen > maxChars) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = line.length;
    } else {
      current.push(line);
      currentLen = nextLen;
    }
  }

  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function formatFallbackMessages(title, lines, fallback) {
  const messages = [];
  const results = fallback?.results || [];
  const summary = summarizeTriggered(results);
  const successLines = results
    .filter(item => item.ok && !item.skipped)
    .map(item => `成功 ${item.name}(${item.id}) users=${item.triggeredUsers} batches=${item.okBatches}/${item.totalBatches}`);
  const skippedLines = results
    .filter(item => item.ok && item.skipped)
    .map(item => `跳过 ${item.name}(${item.id}) ${item.reason || "fallback_already_triggered_today"}`);
  const failLines = results
    .filter(item => !item.ok)
    .map(item => `失败 ${item.name}(${item.id}) ${item.error}`);

  messages.push(
    [
      title,
      ...lines,
      `兜底候选学校: ${fallback?.dueCount || 0}`,
      `成功学校: ${summary.ok}`,
      `跳过学校: ${summary.skipped}`,
      `失败学校: ${summary.fail}`,
    ].filter(Boolean).join("\n")
  );

  if (successLines.length) {
    for (const chunk of chunkLines(successLines)) {
      messages.push(["兜底触发成功明细", chunk].join("\n"));
    }
  }

  if (failLines.length) {
    for (const chunk of chunkLines(failLines)) {
      messages.push(["兜底触发失败明细", chunk].join("\n"));
    }
  }

  if (skippedLines.length) {
    for (const chunk of chunkLines(skippedLines)) {
      messages.push(["兜底触发跳过明细", chunk].join("\n"));
    }
  }

  return messages;
}

async function triggerDueSchools(env, options = {}) {
  const schools = await getSchools(env);
  const dueSchools = schools.filter(shouldTriggerSchoolNow);
  const results = [];

  for (const school of dueSchools) {
    try {
      const result = await triggerSchool(env, school.id, options);
      results.push({
        ok: true,
        id: school.id,
        name: school.name,
        triggeredUsers: result.triggeredUsers || 0,
        okBatches: result.okBatches || 0,
        totalBatches: result.totalBatches || 0,
        skipped: !!result.skipped,
        reason: result.reason || "",
      });
    } catch (e) {
      results.push({
        ok: false,
        id: school.id,
        name: school.name,
        error: e.message || String(e),
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    dueCount: dueSchools.length,
    results,
  };
}

async function runWatchdog(env, options = {}) {
  const thresholdMinutes = parseInt(env.TRIGGER_TIMEOUT_MINUTES || "30", 10);
  const thresholdMs = Math.max(1, thresholdMinutes) * 60 * 1000;
  const fallbackOptions = {
    triggerSource: "worker2",
    fallbackMode: options.manual ? "manual" : "scheduled",
  };

  let status;
  try {
    status = await getWorker1Status(env);
  } catch (e) {
    const fallback = await triggerDueSchools(env, fallbackOptions);
    const notifications = await sendFeishuAlerts(
      env,
      formatFallbackMessages(
        "worker2 告警：无法读取 tongyi 状态接口，已执行兜底触发。",
        [
        `错误: ${e.message || String(e)}`,
        `北京时间: ${beijingHMS()}`,
        ],
        fallback
      )
    );
    return {
      ok: false,
      mode: "status_unreachable",
      manual: !!options.manual,
      reason: e.message || String(e),
      fallback,
      notifications,
    };
  }

  const lastRunAt = status?.lastScheduledRun?.at;
  const lastRunTs = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const ageMs = Number.isNaN(lastRunTs) ? null : Date.now() - lastRunTs;
  const isStale = ageMs === null || ageMs > thresholdMs;

  if (!isStale) {
    return {
      ok: true,
      mode: "healthy",
      now: new Date().toISOString(),
      beijing_time: beijingHMS(),
      thresholdMinutes,
      lastScheduledRun: status.lastScheduledRun,
      ageMs,
    };
  }

  const fallback = await triggerDueSchools(env, fallbackOptions);
  const notifications = await sendFeishuAlerts(
    env,
    formatFallbackMessages(
      "worker2 告警：tongyi 心跳超时，已执行兜底触发。",
      [
      `最近心跳: ${lastRunAt || "无记录"}`,
      `超时阈值: ${thresholdMinutes} 分钟`,
      `北京时间: ${beijingHMS()}`,
      ageMs === null ? "" : `距离上次心跳: ${Math.round(ageMs / 1000)} 秒`,
      ],
      fallback
    )
  );

  return {
    ok: false,
    mode: "stale",
    manual: !!options.manual,
    thresholdMinutes,
    lastScheduledRun: status.lastScheduledRun || null,
    ageMs,
    fallback,
    notifications,
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatchdog(env, { manual: false }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      return jsonResp(await runWatchdog(env, { manual: true }));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResp({
        ok: true,
        worker: "worker2",
        now: new Date().toISOString(),
        beijing_time: beijingHMS(),
      });
    }

    return jsonResp({
      ok: true,
      worker: "worker2",
      message: "Use POST /run to execute the watchdog manually.",
      now: new Date().toISOString(),
      beijing_time: beijingHMS(),
    });
  },
};
