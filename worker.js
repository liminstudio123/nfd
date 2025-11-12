const TOKEN = ENV_BOT_TOKEN
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET
const ADMIN_UID = ENV_ADMIN_UID

const NOTIFY_INTERVAL = 3600 * 1000;
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md';
const enable_notification = true

// ========== 工具函数 ==========
function apiUrl(methodName, params = null) {
  let query = ''
  if (params) query = '?' + new URLSearchParams(params).toString()
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}
function requestTelegram(methodName, body, params = null) {
  return fetch(apiUrl(methodName, params), body).then(r => r.json())
}
function makeReqBody(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}
function sendMessage(msg = {}) { return requestTelegram('sendMessage', makeReqBody(msg)) }
function copyMessage(msg = {}) { return requestTelegram('copyMessage', makeReqBody(msg)) }
function forwardMessage(msg) { return requestTelegram('forwardMessage', makeReqBody(msg)) }

// ========== Worker 主入口 ==========
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) event.respondWith(handleWebhook(event))
  else if (url.pathname === '/registerWebhook') event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  else if (url.pathname === '/unRegisterWebhook') event.respondWith(unRegisterWebhook(event))
  else event.respondWith(new Response('No handler for this request'))
})

// ========== Webhook ==========
async function handleWebhook(event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }
  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

// ========== Update ==========
async function onUpdate(update) {
  if ('message' in update) await onMessage(update.message)
}

// ========== 消息核心处理（三道铁锁）==========
async function onMessage(message) {
  const chatId = message.chat.id;
  const chatType = message.chat.type;          // private / channel / group / supergroup
  const from = message.from;

  // === 第1道锁：禁止所有频道消息 ===
  if (chatType === 'channel') {
    // 可选：给管理员发一条提醒
    // await sendMessage({chat_id: ADMIN_UID, text: `频道 ${message.chat.title} 试图发消息，已自动屏蔽`});
    return;   // 直接无视
  }

  // === 第2道锁：禁止任何机器人发消息 ===
  if (from && from.is_bot) {
    // 可选提醒管理员
    // await sendMessage({chat_id: ADMIN_UID, text: `机器人 @${from.username} 试图联系，已屏蔽`});
    return;   // 直接无视
  }

  // === 第3道锁：禁止任何人转发消息 ===
  if (
    message.forward_from ||
    message.forward_from_chat ||
    message.forward_sender_name ||
    message.forward_signature ||
    message.forward_date
  ) {
    return sendMessage({
      chat_id: chatId,
      text: '本机器人禁止接收任何已转发的消息。\n请直接发送原创内容。',
      parse_mode: 'Markdown'
    });
  }

  // === /start 命令 ===
  if (message.text === '/start') {
    let startMsg = await fetch(startMsgUrl).then(r => r.text());
    return sendMessage({ chat_id: chatId, text: startMsg });
  }

  // === 管理员专属功能 ===
  if (message.chat.id.toString() === ADMIN_UID) {
    if (!message?.reply_to_message?.chat) {
      return sendMessage({
        chat_id: ADMIN_UID,
        text: '使用方法：回复用户消息后发送内容，或使用 `/block` `/unblock` `/checkblock`'
      });
    }
    if (/^\/block$/.exec(message.text)) return handleBlock(message);
    if (/^\/unblock$/.exec(message.text)) return handleUnBlock(message);
    if (/^\/checkblock$/.exec(message.text)) return checkBlock(message);

    let guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
    if (guestChatId) {
      return copyMessage({
        chat_id: guestChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id
      });
    }
  }

  // === 普通用户正常流程 ===
  return handleGuestMessage(message);
}

// ========== 普通用户处理 ==========
async function handleGuestMessage(message) {
  const chatId = message.chat.id;

  // 被屏蔽？
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" });
  if (isblocked) {
    return sendMessage({ chat_id: chatId, text: 'You are blocked' });
  }

  // 转发给管理员
  let forwardReq = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  });

  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId);
  }

  return handleNotify(message);
}

// ========== 防骗提醒 ==========
async function handleNotify(message) {
  let chatId = message.chat.id;
  if (await isFraud(chatId)) {
    return sendMessage({ chat_id: ADMIN_UID, text: `检测到骗子，UID${chatId}` });
  }
  if (enable_notification) {
    let last = await nfd.get('lastmsg-' + chatId, { type: "json" });
    if (!last || Date.now() - last > NOTIFY_INTERVAL) {
      await nfd.put('lastmsg-' + chatId, Date.now());
      return sendMessage({
        chat_id: ADMIN_UID,
        text: await fetch(notificationUrl).then(r => r.text())
      });
    }
  }
}

// ========== 屏蔽/解禁 ==========
async function handleBlock(message) {
  let guest = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  if (guest === ADMIN_UID) return sendMessage({ chat_id: ADMIN_UID, text: '不能屏蔽自己' });
  await nfd.put('isblocked-' + guest, true);
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guest} 已屏蔽` });
}
async function handleUnBlock(message) {
  let guest = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  await nfd.put('isblocked-' + guest, false);
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guest} 已解除屏蔽` });
}
async function checkBlock(message) {
  let guest = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  let blocked = await nfd.get('isblocked-' + guest, { type: "json" });
  return sendMessage({ chat_id: ADMIN_UID, text: `UID:${guest} ${blocked ? '已被屏蔽' : '未屏蔽'}` });
}

// ========== Webhook 注册 ==========
async function registerWebhook(event, reqUrl, suffix, secret) {
  const url = `${reqUrl.protocol}//${reqUrl.hostname}${suffix}`;
  const r = await (await fetch(apiUrl('setWebhook', { url, secret_token: secret }))).json();
  return new Response(r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}
async function unRegisterWebhook() {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json();
  return new Response(r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

// ========== 骗子库 ==========
async function isFraud(id) {
  id = id.toString();
  let db = await fetch(fraudDb).then(r => r.text());
  return db.split('\n').filter(v => v).includes(id);
}
