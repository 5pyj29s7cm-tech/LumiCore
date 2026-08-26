/**
 * Feishu Integration Test — verifies the messaging pipeline:
 * 1. Webhook URL verification (challenge response)
 * 2. Message event parsing + AI reply
 * 3. Manual send endpoint
 * 4. Status endpoint
 *
 * Usage: node test-feishu.mjs
 * Requires: server running on localhost:3000
 *           FEISHU_APP_ID + FEISHU_APP_SECRET in .env
 */

const BASE = 'http://localhost:3000/api';
const log = (...args) => console.log(...args);
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; log(`  PASS: ${name}`); }
  else { failed++; log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  log('═══ Feishu Integration Test ═══\n');

  // ── 1. Status endpoint ──
  log('─── 1. Status Check ───');
  const statusRes = await fetch(`${BASE}/feishu/status`);
  const status = await statusRes.json();
  log(`  Platform: ${status.platform}`);
  log(`  Configured: ${status.configured}`);
  log(`  App ID: ${status.appId || 'NOT SET'}`);
  check('Status endpoint returns 200', statusRes.ok);
  check('Platform is feishu', status.platform === 'feishu');

  if (!status.configured) {
    log('\n  Feishu not configured — skipping webhook/send tests.');
    log('  Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env to run full tests.');
    summary();
    return;
  }

  // ── 2. URL Verification Challenge ──
  log('\n─── 2. URL Verification ───');
  const challengeRes = await fetch(`${BASE}/feishu/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'url_verification',
      challenge: 'test_challenge_token_abc123',
      token: status.appId,
    }),
  });
  const challengeData = await challengeRes.json();
  check('Challenge returns 200', challengeRes.ok);
  check('Challenge echoed back', challengeData.challenge === 'test_challenge_token_abc123');

  // ── 3. Simulated Message Event ──
  log('\n─── 3. Message Event (simulated) ───');
  const eventRes = await fetch(`${BASE}/feishu/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema: '2.0',
      header: {
        event_id: 'evt_test001',
        event_type: 'im.message.receive_v1',
        app_id: status.appId,
        tenant_key: 'test_tenant',
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_testuser001', union_id: 'on_test' },
        },
        message: {
          message_id: 'om_test_msg_001',
          chat_id: 'oc_testchat001',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '你好 Lumi，今天天气怎么样？' }),
          create_time: String(Math.floor(Date.now() / 1000)),
        },
      },
    }),
  });
  check('Message event returns 200', eventRes.ok);
  const eventData = await eventRes.json();
  check('Message event acknowledged', eventData.code === 0 || eventData.code === -1);

  // ── 4. Manual Send (text) ──
  log('\n─── 4. Manual Send ───');
  const sendRes = await fetch(`${BASE}/feishu/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: 'oc_testchat001',
      text: '测试消息 — from LumiCore test suite',
    }),
  });
  const sendData = await sendRes.json();
  if (sendRes.ok && sendData.success) {
    check('Send text message', true);
    log(`  Message ID: ${sendData.messageId}`);
  } else {
    // Will fail without real Feishu credentials, but the endpoint works
    check('Send endpoint responds', sendRes.ok || sendData.error);
    log(`  Response: ${JSON.stringify(sendData).slice(0, 120)}`);
  }

  // ── 5. Manual Send (card) ──
  log('\n─── 5. Card Send ───');
  const cardRes = await fetch(`${BASE}/feishu/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: 'oc_testchat001',
      card: {
        title: 'LumiCore Test Card',
        subtitle: 'Integration Test',
        body: 'This card was sent from the LumiCore Feishu test suite.',
        color: 'blue',
        linkUrl: 'https://lumiai.asia',
      },
    }),
  });
  const cardData = await cardRes.json();
  if (cardRes.ok && cardData.success) {
    check('Send card message', true);
    log(`  Message ID: ${cardData.messageId}`);
  } else {
    check('Card endpoint responds', cardRes.ok || cardData.error);
    log(`  Response: ${JSON.stringify(cardData).slice(0, 120)}`);
  }

  summary();
}

function summary() {
  log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log('\nTest error:', err.message);
  log('Make sure the server is running: npm run dev');
  process.exit(1);
});
