#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const ACCESS_TOKEN = String(process.env.YT_ACCESS_TOKEN || '').trim();
const LIVE_CHAT_ID = String(process.env.YT_LIVE_CHAT_ID || '').trim();
const BROADCAST_ID = String(process.env.YT_BROADCAST_ID || '').trim();

const state = {
  bridgeStatus: 'starting',
  liveChatId: LIVE_CHAT_ID || null,
  nextPageToken: '',
  pollingIntervalMillis: 1500,
  items: [],
  nextSeq: 1,
  counts: new Map(),
  topCountryCode: null,
  lastError: null,
  lastPollAt: null,
  lastMessageAt: null,
};

const COUNTRY_ALIASES = [
  { code: 'in', name: 'India', aliases: ['india', 'bharat', 'hindustan'] },
  { code: 'pk', name: 'Pakistan', aliases: ['pakistan'] },
  { code: 'bd', name: 'Bangladesh', aliases: ['bangladesh'] },
  { code: 'us', name: 'United States', aliases: ['united states', 'usa', 'us', 'america'] },
  { code: 'gb', name: 'United Kingdom', aliases: ['united kingdom', 'uk', 'britain', 'great britain', 'england'] },
  { code: 'br', name: 'Brazil', aliases: ['brazil'] },
  { code: 'ar', name: 'Argentina', aliases: ['argentina'] },
  { code: 'es', name: 'Spain', aliases: ['spain'] },
  { code: 'fr', name: 'France', aliases: ['france'] },
  { code: 'de', name: 'Germany', aliases: ['germany'] },
  { code: 'it', name: 'Italy', aliases: ['italy'] },
  { code: 'pt', name: 'Portugal', aliases: ['portugal'] },
  { code: 'mx', name: 'Mexico', aliases: ['mexico'] },
  { code: 'jp', name: 'Japan', aliases: ['japan'] },
  { code: 'kr', name: 'South Korea', aliases: ['south korea', 'korea'] },
  { code: 'sa', name: 'Saudi Arabia', aliases: ['saudi arabia', 'saudi'] },
  { code: 'za', name: 'South Africa', aliases: ['south africa'] },
  { code: 'ng', name: 'Nigeria', aliases: ['nigeria'] },
  { code: 'au', name: 'Australia', aliases: ['australia'] },
];

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCountryFromComment(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  for (const country of COUNTRY_ALIASES) {
    if (country.aliases.some((alias) => normalized === alias || normalized.includes(` ${alias} `) || normalized.startsWith(`${alias} `) || normalized.endsWith(` ${alias}`))) {
      return country;
    }
  }
  return null;
}

function formatCountryCounts() {
  const sorted = [...state.counts.entries()]
    .map(([countryCode, count]) => {
      const country = COUNTRY_ALIASES.find((entry) => entry.code === countryCode);
      return {
        countryCode,
        countryName: country ? country.name : countryCode.toUpperCase(),
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.countryName.localeCompare(b.countryName));

  return sorted;
}

function updateTopCountry() {
  const sorted = formatCountryCounts();
  state.topCountryCode = sorted.length ? sorted[0].countryCode : null;
}

function pushItem({ text, author, countryCode, countryName }) {
  const item = {
    seq: state.nextSeq++,
    text: String(text || '').slice(0, 240),
    author: String(author || 'YouTube fan').slice(0, 80),
    countryCode: countryCode || null,
    countryName: countryName || null,
    createdAt: new Date().toISOString(),
  };

  state.items.push(item);
  if (state.items.length > 800) state.items.splice(0, state.items.length - 800);
  state.lastMessageAt = item.createdAt;

  if (countryCode) {
    state.counts.set(countryCode, (state.counts.get(countryCode) || 0) + 1);
    updateTopCountry();
  }

  return item;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (ACCESS_TOKEN) headers.set('Authorization', `Bearer ${ACCESS_TOKEN}`);
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    const err = new Error(`Invalid JSON from ${url}`);
    err.status = response.status;
    err.data = text;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`YouTube API request failed with ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function resolveLiveChatId() {
  if (state.liveChatId) return state.liveChatId;
  if (!BROADCAST_ID) {
    throw new Error('Set YT_LIVE_CHAT_ID or YT_BROADCAST_ID');
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', BROADCAST_ID);

  const data = await fetchJson(url.toString());
  const liveChatId = data?.items?.[0]?.snippet?.liveChatId;
  if (!liveChatId) {
    throw new Error('Could not resolve liveChatId from the broadcast');
  }

  state.liveChatId = liveChatId;
  return liveChatId;
}

function extractMessageText(snippet) {
  return String(
    snippet?.displayMessage ||
      snippet?.textMessageDetails?.messageText ||
      snippet?.superChatDetails?.amountDisplayString ||
      snippet?.pollOpenedDetails?.prompt ||
      '',
  ).trim();
}

function ingestChatItem(message) {
  const text = extractMessageText(message?.snippet);
  if (!text) return null;

  const country = findCountryFromComment(text);
  return pushItem({
    text,
    author: message?.authorDetails?.displayName || 'YouTube fan',
    countryCode: country ? country.code : null,
    countryName: country ? country.name : null,
  });
}

async function pollOnce() {
  const liveChatId = await resolveLiveChatId();
  const url = new URL('https://www.googleapis.com/youtube/v3/liveChatMessages');
  url.searchParams.set('liveChatId', liveChatId);
  url.searchParams.set('part', 'snippet,authorDetails');
  url.searchParams.set('maxResults', '200');
  if (state.nextPageToken) url.searchParams.set('pageToken', state.nextPageToken);

  const data = await fetchJson(url.toString());
  state.nextPageToken = data?.nextPageToken || state.nextPageToken;
  state.pollingIntervalMillis = Math.max(1000, Number(data?.pollingIntervalMillis || 1500));
  state.lastPollAt = new Date().toISOString();
  state.bridgeStatus = 'online';
  state.lastError = null;

  for (const message of data?.items || []) {
    ingestChatItem(message);
  }
}

function summarizeStatus() {
  const top = state.topCountryCode
    ? COUNTRY_ALIASES.find((country) => country.code === state.topCountryCode)
    : null;

  return {
    bridgeStatus: state.bridgeStatus,
    liveChatId: state.liveChatId,
    pollingIntervalMillis: state.pollingIntervalMillis,
    lastPollAt: state.lastPollAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    topCountry: top
      ? {
          code: top.code,
          name: top.name,
          count: state.counts.get(top.code) || 0,
        }
      : null,
    counts: formatCountryCounts(),
  };
}

function handleFeed(req, res, since) {
  const sinceSeq = Number.isFinite(since) ? since : 0;
  const items = state.items.filter((item) => item.seq > sinceSeq);
  sendJson(res, 200, {
    ok: true,
    nextSeq: state.nextSeq,
    items,
    status: summarizeStatus(),
  });
}

async function handleInject(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) {
      sendJson(res, 413, { ok: false, error: 'Request body too large' });
      req.destroy();
      return;
    }
  }
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
    return;
  }

  const text = String(payload.text || '').trim();
  if (!text) {
    sendJson(res, 400, { ok: false, error: 'text is required' });
    return;
  }

  const country = findCountryFromComment(text);
  const item = pushItem({
    text,
    author: String(payload.author || 'Manual test').trim() || 'Manual test',
    countryCode: country ? country.code : null,
    countryName: country ? country.name : null,
  });

  sendJson(res, 200, { ok: true, item, status: summarizeStatus() });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (requestUrl.pathname === '/') {
    sendText(
      res,
      200,
      [
        'YouTube live comment bridge is running.',
        '',
        'Endpoints:',
        'GET  /status',
        'GET  /feed?since=0',
        'POST /inject  {"text":"India won","author":"test"}',
        '',
        'Required env:',
        'YT_ACCESS_TOKEN',
        'YT_LIVE_CHAT_ID or YT_BROADCAST_ID',
      ].join('\n'),
    );
    return;
  }

  if (requestUrl.pathname === '/status') {
    sendJson(res, 200, { ok: true, ...summarizeStatus() });
    return;
  }

  if (requestUrl.pathname === '/feed') {
    handleFeed(req, res, Number(requestUrl.searchParams.get('since') || 0));
    return;
  }

  if (requestUrl.pathname === '/inject' && req.method === 'POST') {
    await handleInject(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

async function pollForever() {
  while (true) {
    try {
      await pollOnce();
      await sleep(state.pollingIntervalMillis);
    } catch (error) {
      state.bridgeStatus = 'offline';
      state.lastError = error?.data || error?.message || String(error);
      const wait = Math.max(5000, state.pollingIntervalMillis || 5000);
      console.error('[yt-bridge]', state.lastError);
      await sleep(wait);
    }
  }
}

async function main() {
  if (!ACCESS_TOKEN) {
    console.error('Missing YT_ACCESS_TOKEN. The bridge cannot read real live chat without it.');
    console.error('Provide YT_ACCESS_TOKEN and either YT_LIVE_CHAT_ID or YT_BROADCAST_ID.');
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[yt-bridge] listening on http://127.0.0.1:${PORT}`);
  });

  state.bridgeStatus = 'starting';
  pollForever().catch((error) => {
    console.error('[yt-bridge] fatal error:', error);
    process.exitCode = 1;
  });
}

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

main().catch((error) => {
  console.error('[yt-bridge] failed to start:', error);
  process.exit(1);
});
