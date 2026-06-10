const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROUTER_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROUTER_DIR, 'config.json');
const CC_SWITCH_DIR = path.join(os.homedir(), '.cc-switch');
const CC_SWITCH_SETTINGS_PATH = path.join(CC_SWITCH_DIR, 'settings.json');
const CC_SWITCH_DB_PATH = path.join(CC_SWITCH_DIR, 'cc-switch.db');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function loadRouterConfig() {
  return readJson(CONFIG_PATH);
}

function loadClaudeProviderConfig() {
  const settings = readJson(CC_SWITCH_SETTINGS_PATH);
  const providerId = settings.currentProviderClaude;
  if (!providerId) {
    throw new Error('currentProviderClaude is missing in ~/.cc-switch/settings.json');
  }

  const db = new DatabaseSync(CC_SWITCH_DB_PATH);
  try {
    const row = db
      .prepare('SELECT name, settings_config FROM providers WHERE id = ?')
      .get(providerId);

    if (!row) {
      throw new Error(`Provider ${providerId} not found in ~/.cc-switch/cc-switch.db`);
    }

    const settingsConfig = JSON.parse(row.settings_config || '{}');
    const env = settingsConfig.env || {};
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const authToken = env.ANTHROPIC_AUTH_TOKEN;

    if (!baseUrl || !authToken) {
      throw new Error(`Provider ${row.name} is missing ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN`);
    }

    return {
      providerId,
      providerName: row.name,
      baseUrl,
      authToken,
    };
  } finally {
    db.close();
  }
}

function buildRuntimeConfig() {
  return {
    ...loadRouterConfig(),
    upstream: loadClaudeProviderConfig(),
  };
}

function buildImageEndpoint(baseUrl) {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('v1/messages', normalized);
}

function normalizeMimeType(imagePath) {
  const ext = path.extname(imagePath).toLowerCase().replace('.', '');
  const mimeMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };

  return mimeMap[ext] || 'image/jpeg';
}

function encodeImageFile(imagePath) {
  const bytes = fs.readFileSync(imagePath);
  return {
    mediaType: normalizeMimeType(imagePath),
    data: bytes.toString('base64'),
  };
}

function analyzeImageData(runtime, image, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const endpoint = buildImageEndpoint(runtime.upstream.baseUrl);
    const body = JSON.stringify({
      model: runtime.model_image,
      max_tokens: maxTokens || runtime.image_max_tokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data,
              },
            },
            {
              type: 'text',
              text: prompt || runtime.image_analysis_prompt,
            },
          ],
        },
      ],
    });

    const transport = endpoint.protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'anthropic-version': '2023-06-01',
          'x-api-key': runtime.upstream.authToken,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            const payload = JSON.parse(raw);
            if (res.statusCode >= 400 || payload.error) {
              reject(
                new Error(
                  payload.error?.message || `Image analysis failed with HTTP ${res.statusCode}`,
                ),
              );
              return;
            }

            const text = (payload.content || [])
              .map((item) => item.text || '')
              .join('')
              .trim();

            resolve(text || '(视觉模型没有返回文本描述)');
          } catch (error) {
            reject(new Error(`Failed to parse image analysis response: ${error.message}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function analyzeImageFile(imagePath, prompt, maxTokens) {
  const runtime = buildRuntimeConfig();
  const image = encodeImageFile(imagePath);
  return analyzeImageData(runtime, image, prompt, maxTokens);
}

module.exports = {
  analyzeImageData,
  analyzeImageFile,
  buildRuntimeConfig,
};
