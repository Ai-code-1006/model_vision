const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { analyzeImageData, buildRuntimeConfig } = require('./core/vision');

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_REPAIR_INTERVAL_MS = 5000;
const LOGS_DIR = path.join(__dirname, 'logs');

fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function getLogPath(kind) {
  const suffix = kind === 'error' ? '.err.log' : '.log';
  return path.join(LOGS_DIR, `router-${getLogDateStamp()}${suffix}`);
}

function appendLine(filePath, message) {
  try {
    fs.appendFileSync(filePath, `${message}\n`, 'utf8');
  } catch {
    // Avoid crashing the router on log write failures.
  }
}

function log(message) {
  const stamp = new Date().toISOString();
  appendLine(getLogPath('info'), `[${stamp}] ${message}`);
}

function logError(message) {
  const stamp = new Date().toISOString();
  appendLine(getLogPath('error'), `[${stamp}] ${message}`);
}

function ensureClaudeBaseUrl(listenPort) {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return;

    const rawSettings = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const settings = JSON.parse(rawSettings);
    settings.env = settings.env || {};
    const expectedBaseUrl = `http://127.0.0.1:${listenPort}`;

    if (settings.env.ANTHROPIC_BASE_URL === expectedBaseUrl) return;

    settings.env.ANTHROPIC_BASE_URL = expectedBaseUrl;
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    log(`repaired Claude settings: ANTHROPIC_BASE_URL=${expectedBaseUrl}`);
  } catch (error) {
    logError(`failed to repair Claude settings: ${error.message}`);
  }
}

function blockHasImage(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'image' || block.type === 'image_url') return true;
  if (block.source?.type === 'base64') return true;
  if (block.media_type && block.data) return true;
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return block.content.some(blockHasImage);
  }
  return false;
}

function hasImage(body) {
  return body?.messages?.some(
    (msg) => Array.isArray(msg.content) && msg.content.some(blockHasImage),
  );
}

function extractImages(body) {
  const images = [];

  for (const msg of body.messages || []) {
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!blockHasImage(block)) continue;

      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (!blockHasImage(nested)) continue;
          images.push({
            mediaType: nested.source?.media_type || nested.media_type || 'image/png',
            data: nested.source?.data || nested.data || '',
          });
        }
        continue;
      }

      images.push({
        mediaType: block.source?.media_type || block.media_type || 'image/png',
        data: block.source?.data || block.data || '',
      });
    }
  }

  return images.filter((image) => image.data);
}

function stripImageBlocks(blocks) {
  const cleaned = [];

  for (const block of blocks) {
    if (blockHasImage(block)) {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const nested = block.content.filter((entry) => !blockHasImage(entry));
        if (nested.length > 0) {
          cleaned.push({ ...block, content: nested });
        } else {
          cleaned.push({
            type: 'text',
            text: '(图片结果已由视觉模型分析并注入上下文)',
          });
        }
      }
      continue;
    }

    cleaned.push(block);
  }

  return cleaned;
}

function removeImagesFromBody(body) {
  for (const msg of body.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = stripImageBlocks(msg.content);
    if (msg.content.length === 0) {
      msg.content = [{ type: 'text', text: '(用户发送了图片，已由视觉模型分析)' }];
    }
  }
  return body;
}

function injectAnalysis(body, analyses) {
  const analysisText = analyses
    .map((analysis, index) => `[图片${index + 1}分析]\n${analysis}`)
    .join('\n\n');

  if (!analysisText) return body;

  if (typeof body.system === 'string' && body.system.length > 0) {
    body.system += `\n\n${analysisText}`;
    return body;
  }

  if (Array.isArray(body.system)) {
    body.system.push({ type: 'text', text: analysisText });
    return body;
  }

  body.system = analysisText;
  return body;
}

function extractUserContext(body, maxMessages = 3, maxChars = 2000) {
  const texts = [];

  for (let i = (body.messages || []).length - 1; i >= 0 && texts.length < maxMessages; i--) {
    const msg = body.messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        texts.unshift(block.text.trim());
      }
    }
  }

  const joined = texts.join('\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

function buildContextAwarePrompt(context, defaultPrompt) {
  if (!context) return defaultPrompt;

  return [
    defaultPrompt,
    '',
    '用户当前正在和AI对话，以下是用户最近的发言，请根据用户的意图重点分析图片中与用户问题相关的内容：',
    '',
    '---',
    context,
    '---',
  ].join('\n');
}

function sendProxyError(clientRes, statusCode, code, message) {
  if (clientRes.writableEnded || clientRes.destroyed) return;
  if (!clientRes.headersSent) {
    clientRes.writeHead(statusCode, { 'content-type': 'application/json' });
  }
  clientRes.end(JSON.stringify({ error: code, message }));
}

function proxyToCcSwitch(runtime, clientReq, clientRes, payload) {
  const proxy = http.request(
    {
      hostname: '127.0.0.1',
      port: runtime.cc_switch_port,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: `127.0.0.1:${runtime.cc_switch_port}`,
        'content-length': payload.length,
      },
    },
    (upstreamRes) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      }

      upstreamRes.on('error', (error) => {
        logError(`upstream response error: ${error.message}`);
        if (!clientRes.destroyed) {
          clientRes.destroy(error);
        }
      });

      upstreamRes.pipe(clientRes);
    },
  );

  proxy.on('error', (error) => {
    logError(`proxy error: ${error.message}`);
    sendProxyError(clientRes, 502, 'router_proxy_error', error.message);
  });

  proxy.write(payload);
  proxy.end();
}

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];

  clientReq.on('data', (chunk) => chunks.push(chunk));
  clientReq.on('end', async () => {
    const raw = Buffer.concat(chunks);
    let payload = raw;

    if (clientReq.method === 'POST' && raw.length > 0) {
      try {
        const runtime = buildRuntimeConfig();
        const body = JSON.parse(raw.toString());

        if (hasImage(body)) {
          const images = extractImages(body);
          log(`image request detected: ${images.length} image(s) -> ${runtime.model_image} analyze -> ${runtime.model_text} answer`);

          const userContext = extractUserContext(body);
          const analysisPrompt = buildContextAwarePrompt(userContext, runtime.image_analysis_prompt);
          log(`context-aware prompt: ${userContext ? `${userContext.length} chars from user messages` : 'no user context, using default'}`);

          const analyses = [];
          for (const [index, image] of images.entries()) {
            try {
              const analysis = await analyzeImageData(runtime, image, analysisPrompt);
              analyses.push(analysis);
              log(`image ${index + 1} analyzed successfully`);
            } catch (error) {
              const note = `(图片${index + 1}分析失败: ${error.message})`;
              analyses.push(note);
              logError(note);
            }
          }

          removeImagesFromBody(body);
          injectAnalysis(body, analyses);
          body.model = runtime.model_text;
        } else if (body && typeof body === 'object') {
          body.model = runtime.model_text;
          log(`text request -> ${runtime.model_text}`);
        }

        payload = Buffer.from(JSON.stringify(body));
        proxyToCcSwitch(runtime, clientReq, clientRes, payload);
        return;
      } catch (error) {
        logError(`router fallback: ${error.message}`);
      }
    }

    try {
      const runtime = buildRuntimeConfig();
      proxyToCcSwitch(runtime, clientReq, clientRes, payload);
    } catch (error) {
      logError(`runtime config error: ${error.message}`);
      sendProxyError(clientRes, 500, 'router_runtime_config_error', error.message);
    }
  });
});

process.on('uncaughtException', (error) => {
  logError(`uncaught exception: ${error.stack || error.message}`);
});

process.on('unhandledRejection', (reason) => {
  logError(`unhandled rejection: ${reason?.stack || reason}`);
});

function validateConfig(config) {
  const errors = [];
  if (typeof config.listen_port !== 'number') errors.push('listen_port must be a number');
  if (typeof config.cc_switch_port !== 'number') errors.push('cc_switch_port must be a number');
  if (typeof config.model_text !== 'string' || !config.model_text) errors.push('model_text must be a non-empty string');
  if (typeof config.model_image !== 'string' || !config.model_image) errors.push('model_image must be a non-empty string');
  if (typeof config.image_max_tokens !== 'number') errors.push('image_max_tokens must be a number');
  if (typeof config.image_analysis_prompt !== 'string' || !config.image_analysis_prompt) errors.push('image_analysis_prompt must be a non-empty string');
  if (errors.length) {
    throw new Error(`Invalid config.json:\n  ${errors.join('\n  ')}`);
  }
}

const runtime = buildRuntimeConfig();
validateConfig(runtime);

log(`model_image: ${runtime.model_image}`);
log(`model_text:  ${runtime.model_text}`);
log(`listen_port: ${runtime.listen_port}`);
log(`cc_switch:   ${runtime.cc_switch_port}`);
log(`max_tokens:  ${runtime.image_max_tokens}`);

ensureClaudeBaseUrl(runtime.listen_port);
setInterval(() => ensureClaudeBaseUrl(runtime.listen_port), SETTINGS_REPAIR_INTERVAL_MS);

server.listen(runtime.listen_port, '127.0.0.1', () => {
  log(`model-router listening on http://127.0.0.1:${runtime.listen_port}`);
  log(`text path: Claude -> router -> cc-switch(${runtime.cc_switch_port}) -> ${runtime.model_text}`);
  log(`image path: Claude -> router -> ${runtime.model_image} analyze -> cc-switch(${runtime.cc_switch_port}) -> ${runtime.model_text}`);
});
