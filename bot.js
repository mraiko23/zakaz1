const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// ============ CONFIGURATION ============
const BOT_TOKEN = '8389980079:AAHApCF_DWVJ2s_xdLQ7anXf4K7v2CxrgBs';
const ADMIN_USERNAME = 'Flomaster_Tg';
const HTTP_PORT = 3000;
const DB_FILE = 'db.json';

// ============ DATABASE FUNCTIONS ============
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading database:', error);
  }
  
  // Default database structure
  return {
    users: {},
    tasks: [],
    opChannels: [], // Required channels (OP channels)
    withdrawalRequests: [], // Withdrawal requests
    promocodes: [], // Promocodes for withdrawal bonuses
    settings: {
      welcomeText: '👋 Добро пожаловать! Выполняйте задания и получайте Робуксы!',
      referralReward: 100,
      unsubscribePenalty: 50,
      minWithdrawal: 100, // Minimum withdrawal amount
      aboutText: '📢 О боте\n\nЗдесь вы можете заработать Робуксы, выполняя простые задания!',
      channelLink: 'https://t.me/yourchannel',
      withdrawalsLink: 'https://t.me/yourwithdrawals',
      giveawaysLink: 'https://t.me/yourgiveaways',
      supportContact: '@support',
      techSupport: '@tech_support',
      adminId: null // Admin chat ID for notifications
    },
    subscriptionChecks: {}
  };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving database:', error);
    return false;
  }
}

let db = loadDB();

// Initialize new fields if they don't exist
if (!db.withdrawalRequests) {
  db.withdrawalRequests = [];
  saveDB(db);
}
if (!db.settings.minWithdrawal) {
  db.settings.minWithdrawal = 100;
  saveDB(db);
}
if (!db.promocodes) {
  db.promocodes = [];
  saveDB(db);
}

// ============ HTTP SERVER FOR DB DOWNLOAD/UPLOAD ============
const app = express();
const upload = multer({ dest: 'uploads/' });

app.get(`/${BOT_TOKEN}/db.json/down`, (req, res) => {
  res.download(DB_FILE, 'db.json', (err) => {
    if (err) {
      console.error('Download error:', err);
      res.status(500).send('Error downloading database');
    }
  });
});

app.post(`/${BOT_TOKEN}/db.json/load`, upload.single('database'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No file uploaded');
    }
    
    const uploadedData = fs.readFileSync(req.file.path, 'utf8');
    const newDB = JSON.parse(uploadedData);
    
    // Validate structure
    if (!newDB.users || !newDB.tasks || !newDB.settings) {
      fs.unlinkSync(req.file.path);
      return res.status(400).send('Invalid database structure');
    }
    
    fs.writeFileSync(DB_FILE, uploadedData, 'utf8');
    db = newDB;
    
    fs.unlinkSync(req.file.path);
    res.send('Database uploaded successfully');
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).send('Error uploading database');
  }
});

app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
  console.log(`Download DB: http://localhost:${HTTP_PORT}/${BOT_TOKEN}/db.json/down`);
  console.log(`Upload DB: http://localhost:${HTTP_PORT}/${BOT_TOKEN}/db.json/load`);
});

// ============ TELEGRAM BOT ============
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ============ USER FUNCTIONS ============
function getUser(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId,
      balance: 0,
      referrals: [],
      completedTasks: [],
      joinedChannels: [],
      lastSubscriptionCheck: Date.now(),
      taskWarnings: {}, // { taskId: { channelId: timestamp } }
      blocked: false, // User blocked status
      withdrawalCooldown: 0, // Timestamp when user can withdraw again
      usedPromocodes: [] // Array of used promocode codes
    };
    saveDB(db);
  }
  // Add taskWarnings if it doesn't exist (for existing users)
  if (!db.users[userId].taskWarnings) {
    db.users[userId].taskWarnings = {};
  }
  // Add blocked if it doesn't exist (for existing users)
  if (db.users[userId].blocked === undefined) {
    db.users[userId].blocked = false;
  }
  // Add withdrawalCooldown if it doesn't exist (for existing users)
  if (!db.users[userId].withdrawalCooldown) {
    db.users[userId].withdrawalCooldown = 0;
  }
  // Add usedPromocodes if it doesn't exist (for existing users)
  if (!db.users[userId].usedPromocodes) {
    db.users[userId].usedPromocodes = [];
  }
  return db.users[userId];
}

function isAdmin(username) {
  return username === ADMIN_USERNAME;
}

// Generate random withdrawal token
function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 8; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// ============ SUBSCRIPTION CHECK ============
async function checkSubscription(userId, channelId) {
  try {
    const member = await bot.getChatMember(channelId, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error('Subscription check error:', error);
    return false;
  }
}

async function checkAllRequiredChannels(userId) {
  const results = [];
  for (const channel of db.opChannels) {
    const isSubscribed = await checkSubscription(userId, channel.id);
    results.push({ channel: channel.name, subscribed: isSubscribed });
  }
  return results;
}

async function isBotAdmin(channelId) {
  try {
    const botInfo = await bot.getMe();
    const member = await bot.getChatMember(channelId, botInfo.id);
    return ['administrator', 'creator'].includes(member.status);
  } catch (error) {
    return false;
  }
}

// ============ KEYBOARDS ============
function mainMenuKeyboard(username = null) {
  const keyboard = [
    [{ text: '💰 Получить Робуксы', callback_data: 'get_robux' }],
    [{ text: 'ℹ️ О боте', callback_data: 'about_bot' }],
    [{ text: '📋 Задания', callback_data: 'tasks' }]
  ];
  
  // Add admin button for admin users
  if (username && isAdmin(username)) {
    keyboard.push([{ text: '🔧 Админ-панель', callback_data: 'admin_menu' }]);
  }
  
  return { inline_keyboard: keyboard };
}

function getRobuxKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '💸 Вывод', callback_data: 'withdraw' }],
      [{ text: '👤 Профиль', callback_data: 'profile' }],
      [{ text: '« Назад', callback_data: 'main_menu' }]
    ]
  };
}

function aboutBotKeyboard() {
  // Helper function to ensure URL is valid
  const ensureValidUrl = (url) => {
    if (!url) return 'https://t.me/telegram';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    // If it starts with @, convert to URL
    if (url.startsWith('@')) return `https://t.me/${url.substring(1)}`;
    // Otherwise assume it's a username
    return `https://t.me/${url}`;
  };
  
  return {
    inline_keyboard: [
      [{ text: '📢 Наш канал', url: ensureValidUrl(db.settings.channelLink) }],
      [{ text: '💳 Выводы', url: ensureValidUrl(db.settings.withdrawalsLink) }],
      [{ text: '🎁 Розыгрыши', url: ensureValidUrl(db.settings.giveawaysLink) }],
      [{ text: '🛠 Тех. поддержка', url: `https://t.me/${db.settings.techSupport.replace('@', '')}` }],
      [{ text: '« Назад', callback_data: 'main_menu' }]
    ]
  };
}

function tasksKeyboard(page = 0) {
  const tasksPerPage = 5;
  const start = page * tasksPerPage;
  const end = start + tasksPerPage;
  const pageTasks = db.tasks.slice(start, end);
  
  const keyboard = [];
  pageTasks.forEach((task, index) => {
    keyboard.push([{ 
      text: `${start + index + 1}. ${task.title} (${task.reward} Robux)`, 
      callback_data: `task_${task.id}` 
    }]);
  });
  
  const navButtons = [];
  if (page > 0) {
    navButtons.push({ text: '« Назад', callback_data: `tasks_page_${page - 1}` });
  }
  if (end < db.tasks.length) {
    navButtons.push({ text: 'Вперед »', callback_data: `tasks_page_${page + 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  
  keyboard.push([{ text: '« Главное меню', callback_data: 'main_menu' }]);
  
  return { inline_keyboard: keyboard };
}

function taskDetailKeyboard(taskId) {
  const task = db.tasks.find(t => t.id === taskId);
  if (!task) return { inline_keyboard: [[{ text: '« Назад', callback_data: 'tasks' }]] };
  
  const keyboard = [];
  
  // Add channel buttons (up to 4)
  task.channels.forEach((channel, index) => {
    keyboard.push([{ text: `${index + 1}. ${channel.name}`, url: channel.url }]);
  });
  
  keyboard.push([{ text: '✅ Проверка', callback_data: `verify_task_${taskId}` }]);
  keyboard.push([{ text: '« Назад к заданиям', callback_data: 'tasks' }]);
  
  return { inline_keyboard: keyboard };
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📢 Рассылка', callback_data: 'admin_broadcast' }],
      [{ text: '👤 Инфо о пользователе', callback_data: 'admin_user_info' }],
      [{ text: '💰 Добавить робуксы', callback_data: 'admin_add_robux' }],
      [{ text: '💸 Убрать робуксы', callback_data: 'admin_remove_robux' }],
      [{ text: '🚫 Заблокировать пользователя', callback_data: 'admin_block_user' }],
      [{ text: '✅ Разблокировать пользователя', callback_data: 'admin_unblock_user' }],
      [{ text: '🎫 Промокоды', callback_data: 'admin_promocodes' }],
      [{ text: '⭐ ОП каналы', callback_data: 'admin_op_channels' }],
      [{ text: '📋 Каналы в заданиях', callback_data: 'admin_task_channels' }],
      [{ text: '✏️ Изменить приветствие', callback_data: 'admin_edit_welcome' }],
      [{ text: '🎁 Награда за реферала', callback_data: 'admin_edit_referral' }],
      [{ text: 'ℹ️ Изменить текст "О боте"', callback_data: 'admin_edit_about' }],
      [{ text: '📢 Ссылка "Наш канал"', callback_data: 'admin_edit_channel_link' }],
      [{ text: '💳 Ссылка "Выводы"', callback_data: 'admin_edit_withdrawals_link' }],
      [{ text: '🎁 Ссылка "Розыгрыши"', callback_data: 'admin_edit_giveaways_link' }],
      [{ text: '💸 Контакт для вывода', callback_data: 'admin_edit_withdraw_contact' }],
      [{ text: '💵 Мин. сумма вывода', callback_data: 'admin_edit_min_withdrawal' }],
      [{ text: '🆔 Изменить Admin ID', callback_data: 'admin_edit_admin_id' }],
      [{ text: '💰 Цена за отписку', callback_data: 'admin_edit_penalty' }],
      [{ text: '🛠 Изменить тех. поддержку', callback_data: 'admin_edit_support' }],
      [{ text: '« Назад', callback_data: 'main_menu' }]
    ]
  };
}

// ============ BOT HANDLERS ============
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const referralCode = match[1].trim();
  
  // Save admin ID for notifications
  if (username && isAdmin(username) && !db.settings.adminId) {
    db.settings.adminId = userId;
    saveDB(db);
    console.log(`[INFO] Admin ID saved: ${userId}`);
  }
  
  const user = getUser(userId);
  
  // Check if user is blocked
  if (user.blocked && !isAdmin(username)) {
    return bot.sendMessage(chatId, '🚫 Вы заблокированы администратором.\nДоступ к боту ограничен.');
  }
  
  // Handle referral
  if (referralCode && referralCode !== userId.toString()) {
    const referrerId = parseInt(referralCode);
    if (db.users[referrerId] && !db.users[referrerId].referrals.includes(userId)) {
      db.users[referrerId].referrals.push(userId);
      db.users[referrerId].balance += db.settings.referralReward;
      saveDB(db);
      
      bot.sendMessage(referrerId, `🎉 У вас новый реферал! +${db.settings.referralReward} Робуксов`);
    }
  }
  
  // Check required channels
  if (db.opChannels.length > 0) {
    const subscriptions = await checkAllRequiredChannels(userId);
    const unsubscribed = subscriptions.filter(s => !s.subscribed);
    
    if (unsubscribed.length > 0) {
      let message = '⚠️ Для использования бота подпишитесь на обязательные каналы:\n\n';
      unsubscribed.forEach(s => {
        message += `❌ ${s.channel}\n`;
      });
      
      const keyboard = {
        inline_keyboard: [
          ...db.opChannels.map(ch => [{ text: `📢 ${ch.name}`, url: ch.url }]),
          [{ text: '✅ Проверить подписку', callback_data: 'check_subscriptions' }]
        ]
      };
      
      return bot.sendMessage(chatId, message, { reply_markup: keyboard });
    }
  }
  
  bot.sendMessage(chatId, db.settings.welcomeText, { reply_markup: mainMenuKeyboard(username) });
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
  
  if (!isAdmin(username)) {
    return bot.sendMessage(chatId, '⛔ У вас нет прав администратора');
  }
  
  bot.sendMessage(chatId, '🔧 Админ-панель', { reply_markup: adminMenuKeyboard() });
});

bot.onText(/\/stoptoken (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
  const token = match[1].trim().toUpperCase();
  
  if (!isAdmin(username)) {
    return bot.sendMessage(chatId, '⛔ У вас нет прав администратора');
  }
  
  // Find request by token
  const request = db.withdrawalRequests.find(r => r.token === token);
  
  if (!request) {
    return bot.sendMessage(chatId, `❌ Заявка с токеном ${token} не найдена`);
  }
  
  if (request.status === 'completed') {
    return bot.sendMessage(chatId, `⚠️ Заявка с токеном ${token} уже завершена`);
  }
  
  if (request.status === 'rejected') {
    return bot.sendMessage(chatId, `⚠️ Заявка с токеном ${token} была отклонена`);
  }
  
  if (request.status === 'pending') {
    return bot.sendMessage(chatId, `⚠️ Заявка с токеном ${token} ещё не одобрена`);
  }
  
  // Mark as completed
  request.status = 'completed';
  request.completedAt = Date.now();
  saveDB(db);
  
  bot.sendMessage(chatId, `✅ Заявка завершена!\n\n🆔 ID заявки: ${request.id}\n👤 Пользователь: @${request.username} (ID: ${request.userId})\n💸 Сумма: ${request.amount} Робуксов\n🔑 Токен: ${token}\n\n✅ Вывод обработан!`);
  
  // Notify user
  try {
    await bot.sendMessage(request.userId, `✅ Ваш вывод обработан!\n\n💸 Сумма: ${request.amount} Робуксов\n🔑 Токен: ${token}\n\n🎉 Средства переведены! Спасибо за использование бота!`);
  } catch (error) {
    console.error('Error notifying user:', error);
  }
});

bot.onText(/\/checktoken (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1].trim().toUpperCase();
  
  // Find request by token
  const request = db.withdrawalRequests.find(r => r.token === token);
  
  if (!request) {
    return bot.sendMessage(chatId, `❌ Заявка с токеном ${token} не найдена`);
  }
  
  // Status icons and text
  const statusEmoji = {
    'pending': '⏳',
    'approved': '✅',
    'rejected': '❌',
    'completed': '🎉'
  };
  
  const statusText = {
    'pending': 'Ожидает одобрения',
    'approved': 'Одобрено, ожидает перевода',
    'rejected': 'Отклонено',
    'completed': 'Завершено'
  };
  
  let message = `🔍 Информация о заявке\n\n`;
  message += `🆔 ID заявки: ${request.id}\n`;
  message += `👤 Пользователь: @${request.username} (ID: ${request.userId})\n`;
  message += `💸 Сумма: ${request.amount} Робуксов\n`;
  message += `🔑 Токен: ${token}\n`;
  message += `${statusEmoji[request.status]} Статус: ${statusText[request.status]}\n\n`;
  
  // Add timestamps
  const createdDate = new Date(request.timestamp);
  message += `📅 Создано: ${createdDate.toLocaleString('ru-RU')}\n`;
  
  if (request.approvedAt) {
    const approvedDate = new Date(request.approvedAt);
    message += `✅ Одобрено: ${approvedDate.toLocaleString('ru-RU')}\n`;
  }
  
  if (request.completedAt) {
    const completedDate = new Date(request.completedAt);
    message += `🎉 Завершено: ${completedDate.toLocaleString('ru-RU')}\n`;
  }
  
  bot.sendMessage(chatId, message);
});

// ============ CALLBACK HANDLERS ============
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const username = query.from.username;
  const data = query.data;
  
  bot.answerCallbackQuery(query.id);
  
  // Check if user is blocked
  const user = getUser(userId);
  if (user.blocked && !isAdmin(username)) {
    return bot.answerCallbackQuery(query.id, { text: '🚫 Вы заблокированы администратором', show_alert: true });
  }
  
  // Check if user needs to subscribe to OP channels (except for check_subscriptions, about_bot, admin actions, and delete actions)
  if (!data.startsWith('admin_') && !data.startsWith('delete_op_') && !data.startsWith('delete_task_') && !data.startsWith('delete_promo_') && !data.startsWith('activate_promo') && data !== 'check_subscriptions' && data !== 'main_menu' && data !== 'about_bot') {
    if (db.opChannels.length > 0) {
      const subscriptions = await checkAllRequiredChannels(userId);
      const unsubscribed = subscriptions.filter(s => !s.subscribed);
      
      if (unsubscribed.length > 0) {
        let message = '⚠️ Для использования бота подпишитесь на обязательные каналы:\n\n';
        unsubscribed.forEach(s => {
          message += `❌ ${s.channel}\n`;
        });
        
        const keyboard = {
          inline_keyboard: [
            ...db.opChannels.map(ch => [{ text: `📢 ${ch.name}`, url: ch.url }]),
            [{ text: '✅ Проверить подписку', callback_data: 'check_subscriptions' }]
          ]
        };
        
        bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard
        });
        return;
      }
    }
  }
  
  // Main menu handlers
  if (data === 'main_menu') {
    bot.editMessageText(db.settings.welcomeText, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: mainMenuKeyboard(username)
    });
  }
  
  else if (data === 'get_robux') {
    bot.editMessageText('💰 Получить Робуксы\n\nВыберите действие:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getRobuxKeyboard()
    });
  }
  
  else if (data === 'profile') {
    const user = getUser(userId);
    const referralLink = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
    
    let message = `👤 Ваш профиль\n\n`;
    message += `💰 Баланс: ${user.balance} Робуксов\n`;
    message += `👥 Рефералов: ${user.referrals.length}\n`;
    
    // Show active promocode
    if (user.activePromocode) {
      message += `🎫 Активный промокод: ${user.activePromocode.code} (+${user.activePromocode.bonus}%)\n`;
    }
    
    message += `\n🔗 Ваша реферальная ссылка:\n${referralLink}`;
    
    const keyboard = [
      [{ text: '🎫 Активировать промокод', callback_data: 'activate_promo' }],
      [{ text: '« Назад', callback_data: 'get_robux' }]
    ];
    
    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard }
    });
  }
  
  else if (data === 'withdraw') {
    const user = getUser(userId);
    const minAmount = db.settings.minWithdrawal || 100;
    
    // Check if user has cooldown
    if (user.withdrawalCooldown && user.withdrawalCooldown > Date.now()) {
      const remainingMinutes = Math.ceil((user.withdrawalCooldown - Date.now()) / 60000);
      bot.answerCallbackQuery(query.id, { 
        text: `⏰ Вы сможете подать новую заявку через ${remainingMinutes} мин.`, 
        show_alert: true 
      });
      return;
    }
    
    bot.editMessageText(`💸 Вывод средств\n\n💰 Ваш баланс: ${user.balance} Робуксов\n📉 Минимальная сумма: ${minAmount} Робуксов\n\nВведите сумму для вывода:`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'withdraw_cancel' }]] }
    });
    
    db.adminStates = db.adminStates || {};
    db.adminStates[userId] = { action: 'withdraw_amount' };
    saveDB(db);
  }
  
  else if (data === 'withdraw_cancel') {
    if (db.adminStates && db.adminStates[userId]) {
      delete db.adminStates[userId];
      saveDB(db);
    }
    bot.editMessageText('❌ Вывод отменен', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getRobuxKeyboard()
    });
  }
  
  else if (data === 'activate_promo') {
    bot.sendMessage(chatId, '🎫 Введите промокод:', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'promo_cancel' }]] }});
    db.adminStates = db.adminStates || {};
    db.adminStates[userId] = { action: 'enter_promo' };
    saveDB(db);
  }
  
  else if (data === 'promo_cancel') {
    if (db.adminStates && db.adminStates[userId]) {
      delete db.adminStates[userId];
      saveDB(db);
    }
    bot.sendMessage(chatId, '❌ Действие отменено');
  }
  
  else if (data === 'about_bot') {
    try {
      console.log('About bot button clicked');
      console.log('About text:', db.settings.aboutText);
      bot.editMessageText(db.settings.aboutText, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: aboutBotKeyboard()
      });
    } catch (error) {
      console.error('Error in about_bot handler:', error);
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка при открытии раздела', show_alert: true });
    }
  }
  
  else if (data === 'tasks') {
    const message = db.tasks.length > 0 
      ? '📋 Доступные задания\n\nВыберите задание для выполнения:'
      : '📋 Пока нет доступных заданий';
    
    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: tasksKeyboard(0)
    });
  }
  
  else if (data.startsWith('tasks_page_')) {
    const page = parseInt(data.split('_')[2]);
    bot.editMessageText('📋 Доступные задания\n\nВыберите задание для выполнения:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: tasksKeyboard(page)
    });
  }
  
  else if (data.startsWith('task_') && !data.includes('verify')) {
    const taskId = parseInt(data.split('_')[1]);
    const task = db.tasks.find(t => t.id === taskId);
    
    if (task) {
      const user = getUser(userId);
      const completed = user.completedTasks.includes(taskId);
      
      let message = `📋 ${task.title}\n\n`;
      message += `💰 Награда: ${task.reward} Робуксов\n`;
      message += `📝 Описание: ${task.description}\n\n`;
      
      if (completed) {
        message += '✅ Задание выполнено!';
      } else {
        message += '👇 Подпишитесь на каналы и нажмите "Проверка"';
      }
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: taskDetailKeyboard(taskId)
      });
    }
  }
  
  else if (data.startsWith('verify_task_')) {
    const taskId = parseInt(data.split('_')[2]);
    const task = db.tasks.find(t => t.id === taskId);
    const user = getUser(userId);
    
    if (!task) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Задание не найдено', show_alert: true });
    }
    
    if (user.completedTasks.includes(taskId)) {
      return bot.answerCallbackQuery(query.id, { text: '✅ Вы уже выполнили это задание', show_alert: true });
    }
    
    // Auto-verify subscriptions - all tasks now use automatic verification
    if (task.channels.length > 0) {
      let allSubscribed = true;
      for (const channel of task.channels) {
        const isSubscribed = await checkSubscription(userId, channel.id);
        if (!isSubscribed) {
          allSubscribed = false;
          break;
        }
      }
      
      if (allSubscribed) {
        user.completedTasks.push(taskId);
        user.balance += task.reward;
        user.joinedChannels = [...new Set([...user.joinedChannels, ...task.channels.map(c => c.id)])];
        saveDB(db);
        
        bot.sendMessage(chatId, `✅ Задание выполнено!\n💰 +${task.reward} Робуксов`);
        bot.editMessageReplyMarkup(taskDetailKeyboard(taskId), {
          chat_id: chatId,
          message_id: messageId
        });
      } else {
        bot.answerCallbackQuery(query.id, { text: '❌ Вы не подписаны на все каналы', show_alert: true });
      }
    } else {
      // Task has no channels - just complete it
      user.completedTasks.push(taskId);
      user.balance += task.reward;
      saveDB(db);
      
      bot.sendMessage(chatId, `✅ Задание выполнено!\n💰 +${task.reward} Робуксов`);
      bot.editMessageReplyMarkup(taskDetailKeyboard(taskId), {
        chat_id: chatId,
        message_id: messageId
      });
    }
  }
  
  else if (data === 'check_subscriptions') {
    const subscriptions = await checkAllRequiredChannels(userId);
    const unsubscribed = subscriptions.filter(s => !s.subscribed);
    
    if (unsubscribed.length === 0) {
      bot.sendMessage(chatId, '✅ Отлично! Вы подписаны на все каналы.');
      bot.sendMessage(chatId, db.settings.welcomeText, { reply_markup: mainMenuKeyboard(username) });
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Вы подписаны не на все каналы', show_alert: true });
    }
  }
  
  else if (data.startsWith('recheck_task_')) {
    const taskId = parseInt(data.split('_')[2]);
    const task = db.tasks.find(t => t.id === taskId);
    const user = getUser(userId);
    
    if (!task) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Задание не найдено', show_alert: true });
    }
    
    // Check all channels in the task
    let allSubscribed = true;
    const unsubscribedChannels = [];
    
    for (const channel of task.channels) {
      const isSubscribed = await checkSubscription(userId, channel.id);
      if (!isSubscribed) {
        allSubscribed = false;
        unsubscribedChannels.push(channel.name);
      } else {
        // Clear warning if user resubscribed
        if (user.taskWarnings[taskId] && user.taskWarnings[taskId][channel.id]) {
          delete user.taskWarnings[taskId][channel.id];
        }
      }
    }
    
    // Clean up empty task warnings
    if (user.taskWarnings[taskId] && Object.keys(user.taskWarnings[taskId]).length === 0) {
      delete user.taskWarnings[taskId];
    }
    
    saveDB(db);
    
    if (allSubscribed) {
      bot.answerCallbackQuery(query.id, { text: '✅ Отлично! Вы подписаны на все каналы', show_alert: true });
      bot.sendMessage(chatId, `✅ Предупреждение снято!\n\nВы снова подписаны на все каналы задания "${task.title}".\n💰 Штрафа не будет!`);
    } else {
      bot.answerCallbackQuery(query.id, { text: `❌ Вы еще не подписаны: ${unsubscribedChannels.join(', ')}`, show_alert: true });
    }
  }
  
  // Delete OP channel handler (must be before admin_ block)
  else if (data.startsWith('delete_op_')) {
    if (!isAdmin(username)) {
      return bot.answerCallbackQuery(query.id, { text: '⛔ Нет прав доступа', show_alert: true });
    }
    
    const channelId = data.replace('delete_op_', '');
    const channel = db.opChannels.find(ch => ch.id.toString() === channelId);
    
    if (channel) {
      db.opChannels = db.opChannels.filter(ch => ch.id.toString() !== channelId);
      saveDB(db);
      bot.answerCallbackQuery(query.id, { text: `✅ Канал "${channel.name}" удален`, show_alert: true });
      
      // Refresh the list
      let message = '⭐ ОП Каналы (обязательные для подписки):\n\n';
      const keyboard = [];
      
      if (db.opChannels.length === 0) {
        message += 'Нет добавленных каналов\n\n';
        message += '📝 Для добавления используйте:\n/add_op_channel @channel Название';
      } else {
        db.opChannels.forEach((ch, i) => {
          message += `${i + 1}. ${ch.name}\n🆔 ${ch.id}\n🔗 ${ch.url || 'Нет ссылки'}\n\n`;
          keyboard.push([{ text: `🗑 Удалить "${ch.name}"`, callback_data: `delete_op_${ch.id}` }]);
        });
        message += '\n📝 Команды:\n/add_op_channel @channel Название';
      }
      
      keyboard.push([{ text: '« Назад', callback_data: 'admin_menu' }]);
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
  
  // Delete promo handler (must be before admin_ block)
  else if (data.startsWith('delete_promo_')) {
    if (!isAdmin(username)) {
      return bot.answerCallbackQuery(query.id, { text: '⛔ Нет прав доступа', show_alert: true });
    }
    
    const promoCode = data.replace('delete_promo_', '');
    const promo = db.promocodes.find(p => p.code === promoCode);
    
    if (promo) {
      db.promocodes = db.promocodes.filter(p => p.code !== promoCode);
      saveDB(db);
      bot.answerCallbackQuery(query.id, { text: `✅ Промокод "${promoCode}" удален`, show_alert: true });
      
      // Refresh the list
      let message = '🎫 Управление промокодами\n\n';
      const keyboard = [];
      
      if (db.promocodes.length === 0) {
        message += 'Нет активных промокодов\n\n';
        message += '📝 Для добавления промокода используйте:\n/add_promo КОД процент кол-во\n\n💡 Пример:\n/add_promo BONUS20 20 100\n(код BONUS20, +20% к выводу, 100 использований)';
      } else {
        message += `Всего промокодов: ${db.promocodes.length}\n\n`;
        db.promocodes.forEach((promo, i) => {
          const usedCount = Object.values(db.users).filter(u => u.usedPromocodes && u.usedPromocodes.includes(promo.code)).length;
          message += `${i + 1}. 🎫 ${promo.code}\n`;
          message += `   📈 Бонус: +${promo.bonus}%\n`;
          message += `   👥 Использовано: ${usedCount}/${promo.maxUses}\n\n`;
          keyboard.push([{ text: `🗑 Удалить "${promo.code}"`, callback_data: `delete_promo_${promo.code}` }]);
        });
        message += '\n📝 Добавить: /add_promo КОД процент кол-во';
      }
      
      keyboard.push([{ text: '« Назад', callback_data: 'admin_menu' }]);
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
  
  // Delete task handler (must be before admin_ block)
  else if (data.startsWith('delete_task_')) {
    if (!isAdmin(username)) {
      return bot.answerCallbackQuery(query.id, { text: '⛔ Нет прав доступа', show_alert: true });
    }
    
    const taskId = parseInt(data.replace('delete_task_', ''));
    const task = db.tasks.find(t => t.id === taskId);
    
    if (task) {
      db.tasks = db.tasks.filter(t => t.id !== taskId);
      saveDB(db);
      bot.answerCallbackQuery(query.id, { text: `✅ Задание "${task.title}" удалено`, show_alert: true });
      
      // Refresh the list
      let message = '📋 Управление заданиями\n\n';
      const keyboard = [];
      
      if (db.tasks.length === 0) {
        message += 'Нет созданных заданий\n\n';
        message += '📝 Для создания задания используйте:\n/add_task';
      } else {
        message += `Всего заданий: ${db.tasks.length}\n\n`;
        db.tasks.forEach((task, i) => {
          message += `${i + 1}. ${task.title}\n💰 Награда: ${task.reward} Robux\n📢 Каналов: ${task.channels.length}\n\n`;
          keyboard.push([{ text: `🗑 Удалить "${task.title}"`, callback_data: `delete_task_${task.id}` }]);
        });
        message += '\n📝 Создать новое задание: /add_task';
      }
      
      keyboard.push([{ text: '« Назад', callback_data: 'admin_menu' }]);
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
  
  // Admin handlers
  else if (data.startsWith('admin_')) {
    if (!isAdmin(username)) {
      return bot.answerCallbackQuery(query.id, { text: '⛔ Нет прав доступа', show_alert: true });
    }
    
    if (data === 'admin_broadcast') {
      bot.sendMessage(chatId, '📢 Отправьте сообщение для рассылки:\n\n• Можно отправить текст\n• Можно отправить фото с текстом\n\n🔗 Для добавления кнопок добавьте в конце текста:\n[buttons]\nНазвание 1|https://t.me/channel1\nНазвание 2|https://t.me/channel2', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'broadcast' };
      saveDB(db);
    }
    
    else if (data === 'admin_user_info') {
      bot.sendMessage(chatId, '👤 Введите ID пользователя:', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'user_info' };
      saveDB(db);
    }
    
    else if (data === 'admin_add_robux') {
      bot.sendMessage(chatId, '💰 Добавить робуксы\n\nВведите в формате:\nID сумма\n\nПример: 123456789 100', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'add_robux' };
      saveDB(db);
    }
    
    else if (data === 'admin_remove_robux') {
      bot.sendMessage(chatId, '💸 Убрать робуксы\n\nВведите в формате:\nID сумма\n\nПример: 123456789 50', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'remove_robux' };
      saveDB(db);
    }
    
    else if (data === 'admin_block_user') {
      bot.sendMessage(chatId, '🚫 Заблокировать пользователя\n\nВведите ID пользователя:', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'block_user' };
      saveDB(db);
    }
    
    else if (data === 'admin_unblock_user') {
      bot.sendMessage(chatId, '✅ Разблокировать пользователя\n\nВведите ID пользователя:', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'unblock_user' };
      saveDB(db);
    }
    
    else if (data === 'admin_op_channels') {
      let message = '⭐ ОП Каналы (обязательные для подписки):\n\n';
      const keyboard = [];
      
      if (db.opChannels.length === 0) {
        message += 'Нет добавленных каналов\n\n';
        message += '📝 Для добавления используйте:\n/add_op_channel @channel Название\nили\n/add_op_channel https://t.me/+hash -1001234567890 Название';
      } else {
        db.opChannels.forEach((ch, i) => {
          message += `${i + 1}. ${ch.name}\n🆔 ${ch.id}\n🔗 ${ch.url || 'Нет ссылки'}\n\n`;
          keyboard.push([{ text: `🗑 Удалить "${ch.name}"`, callback_data: `delete_op_${ch.id}` }]);
        });
        message += '\n📝 Команды:\n/add_op_channel @channel Название';
      }
      
      keyboard.push([{ text: '« Назад', callback_data: 'admin_menu' }]);
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    
    else if (data === 'admin_task_channels') {
      let message = '📋 Управление заданиями\n\n';
      const keyboard = [];
      
      if (db.tasks.length === 0) {
        message += 'Нет созданных заданий\n\n';
        message += '📝 Для создания задания используйте:\n/add_task';
      } else {
        message += `Всего заданий: ${db.tasks.length}\n\n`;
        db.tasks.forEach((task, i) => {
          message += `${i + 1}. ${task.title}\n💰 Награда: ${task.reward} Robux\n📢 Каналов: ${task.channels.length}\n\n`;
          keyboard.push([{ text: `🗑 Удалить "${task.title}"`, callback_data: `delete_task_${task.id}` }]);
        });
        message += '\n📝 Создать новое задание: /add_task';
      }
      
      keyboard.push([{ text: '« Назад', callback_data: 'admin_menu' }]);
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    
    else if (data === 'admin_promocodes') {
      let message = '🎫 Управление промокодами\n\n';
      const keyboard = [];
      
      if (db.promocodes.length === 0) {
        message += 'Нет активных промокодов\n\n';
        message += '📝 Для добавления промокода используйте:\n/add_promo КОД процент кол-во\n\n💡 Пример:\n/add_promo BONUS20 20 100\n(код BONUS20, +20% к выводу, 100 использований)';
      } else {
        message += `Всего промокодов: ${db.promocodes.length}\n\n`;
        db.promocodes.forEach((promo, i) => {
          const usedCount = Object.values(db.users).filter(u => u.usedPromocodes && u.usedPromocodes.includes(promo.code)).length;
          message += `${i + 1}. 🎫 ${promo.code}\n`;
          message += `   📈 Бонус: +${promo.bonus}%\n`;
          message += `   👥 Использовано: ${usedCount}/${promo.maxUses}\n\n`;
          keyboard.push([{ text: `🗑 Удалить "${promo.code}"`, callback_data: `delete_promo_${promo.code}` }]);
        });
        message += '\n📝 Добавить: /add_promo КОД процент кол-во';
      }
      
      keyboard.push([{ text: '« Назад', callback_data: 'admin_menu' }]);
      
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    
    else if (data === 'admin_edit_welcome') {
      bot.sendMessage(chatId, '✏️ Введите новый текст приветствия:', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_welcome' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_referral') {
      bot.sendMessage(chatId, `🎁 Текущая награда: ${db.settings.referralReward} Робуксов\n\nВведите новую награду за реферала:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_referral' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_about') {
      bot.sendMessage(chatId, '✏️ Введите новый текст для "О боте":', { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_about' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_penalty') {
      bot.sendMessage(chatId, `💰 Текущий штраф: ${db.settings.unsubscribePenalty} Робуксов\n\nВведите новый штраф за отписку:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_penalty' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_support') {
      bot.sendMessage(chatId, `🛠 Текущая тех. поддержка: ${db.settings.techSupport}\n\nВведите новый контакт тех. поддержки:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_support' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_channel_link') {
      bot.sendMessage(chatId, `📢 Текущая ссылка "Наш канал": ${db.settings.channelLink}\n\nОтправьте новую ссылку:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_channel_link' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_withdrawals_link') {
      bot.sendMessage(chatId, `💳 Текущая ссылка "Выводы": ${db.settings.withdrawalsLink}\n\nОтправьте новую ссылку:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_withdrawals_link' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_giveaways_link') {
      bot.sendMessage(chatId, `🎁 Текущая ссылка "Розыгрыши": ${db.settings.giveawaysLink}\n\nОтправьте новую ссылку:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_giveaways_link' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_withdraw_contact') {
      bot.sendMessage(chatId, `💸 Текущий контакт: ${db.settings.supportContact}\n\nВведите новый контакт для вывода средств:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_withdraw_contact' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_min_withdrawal') {
      bot.sendMessage(chatId, `💵 Текущая минимальная сумма вывода: ${db.settings.minWithdrawal} Робуксов\n\nВведите новую минимальную сумму:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_min_withdrawal' };
      saveDB(db);
    }
    
    else if (data === 'admin_edit_admin_id') {
      bot.sendMessage(chatId, `🆔 Текущий Admin ID: ${db.settings.adminId || 'не установлен'}\n\nВведите новый Admin ID:`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel' }]] }});
      db.adminStates = db.adminStates || {};
      db.adminStates[userId] = { action: 'edit_admin_id' };
      saveDB(db);
    }
    
    else if (data === 'admin_cancel') {
      if (db.adminStates && db.adminStates[userId]) {
        delete db.adminStates[userId];
        saveDB(db);
      }
      bot.sendMessage(chatId, '❌ Действие отменено');
    }
    
    else if (data === 'admin_menu') {
      bot.editMessageText('🔧 Админ-панель', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: adminMenuKeyboard()
      });
    }
  }
  
  // Handle withdrawal request approval (OUTSIDE admin_ block)
  else if (data.startsWith('approve_withdrawal_')) {
    if (!isAdmin(username)) {
      bot.answerCallbackQuery(query.id, { text: '⛔ У вас нет прав администратора', show_alert: true });
      return;
    }
    
    const requestId = parseInt(data.replace('approve_withdrawal_', ''));
    const request = db.withdrawalRequests.find(r => r.id === requestId);
    
    if (!request) {
      bot.answerCallbackQuery(query.id, { text: '❌ Заявка не найдена', show_alert: true });
      return;
    }
    
    if (request.status !== 'pending') {
      bot.answerCallbackQuery(query.id, { text: '⚠️ Заявка уже обработана', show_alert: true });
      return;
    }
    
    // Generate token and mark as approved (not completed)
    const token = generateToken();
    request.status = 'approved';
    request.token = token;
    request.approvedAt = Date.now();
    saveDB(db);
    
    // Update admin message with token
    bot.editMessageText(`✅ Заявка принята!\n\n🆔 ID заявки: ${requestId}\n👤 Пользователь: @${request.username} (ID: ${request.userId})\n💸 Сумма: ${request.amount} Робуксов\n🔑 Токен: ${token}\n\n✅ Статус: Одобрено\n\n💡 Для закрытия заявки используйте:\n/stoptoken ${token}`, {
      chat_id: chatId,
      message_id: messageId
    });
    
    // Send user contact info and token
    try {
      const supportContact = db.settings.supportContact || '@support';
      await bot.sendMessage(request.userId, `✅ Ваша заявка на вывод одобрена!\n\n💸 Сумма: ${request.amount} Робуксов\n🔑 Ваш токен: ${token}\n\n📞 Для получения средств напишите:\n${supportContact}\n\n⚠️ Сообщите этот токен администратору для подтверждения!\n\n💡 Токен действителен до завершения выплаты.`);
    } catch (error) {
      console.error('Error notifying user:', error);
    }
  }
  
  // Handle withdrawal request rejection
  else if (data.startsWith('reject_withdrawal_')) {
    if (!isAdmin(username)) {
      bot.answerCallbackQuery(query.id, { text: '⛔ У вас нет прав администратора', show_alert: true });
      return;
    }
    
    const requestId = parseInt(data.replace('reject_withdrawal_', ''));
    const request = db.withdrawalRequests.find(r => r.id === requestId);
    
    if (!request) {
      bot.answerCallbackQuery(query.id, { text: '❌ Заявка не найдена', show_alert: true });
      return;
    }
    
    if (request.status !== 'pending') {
      bot.answerCallbackQuery(query.id, { text: '⚠️ Заявка уже обработана', show_alert: true });
      return;
    }
    
    // Mark as rejected and return money with cooldown
    request.status = 'rejected';
    const user = getUser(request.userId);
    user.balance += request.amount;
    user.withdrawalCooldown = Date.now() + (60 * 60 * 1000); // 1 hour cooldown
    saveDB(db);
    
    // Update admin message
    bot.editMessageText(`❌ Заявка отклонена!\n\n🆔 ID заявки: ${requestId}\n👤 Пользователь: @${request.username} (ID: ${request.userId})\n💸 Сумма: ${request.amount} Робуксов\n\n❌ Статус: Отклонено`, {
      chat_id: chatId,
      message_id: messageId
    });
    
    // Notify user
    try {
      await bot.sendMessage(request.userId, `❌ Ваша заявка на вывод отклонена\n\n💸 Сумма ${request.amount} Робуксов возвращена на ваш баланс\n💰 Ваш баланс: ${user.balance} Робуксов\n\n⏰ Вы сможете подать новую заявку через 1 час`);
    } catch (error) {
      console.error('Error notifying user:', error);
    }
  }
});

// ============ MESSAGE HANDLERS ============
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return; // Ignore commands
  
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  
  db.adminStates = db.adminStates || {};
  const adminState = db.adminStates[userId];
  
  if (!adminState) {
    return;
  }
  
  // Check if action is for regular users (withdrawal related or promo related)
  const userActions = ['withdraw_amount', 'enter_promo'];
  const isUserAction = userActions.includes(adminState.action);
  
  // For admin actions, check admin privileges
  if (!isUserAction && !isAdmin(username)) {
    delete db.adminStates[userId];
    saveDB(db);
    return;
  }
  
  // Handle admin states
  if (adminState.action === 'broadcast' && isAdmin(username)) {
    let broadcastText = msg.text || msg.caption || '';
    let photo = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    let buttons = null;
    
    // Parse inline buttons from text
    if (broadcastText.includes('[buttons]')) {
      const parts = broadcastText.split('[buttons]');
      broadcastText = parts[0].trim();
      if (parts[1]) {
        const buttonLines = parts[1].trim().split('\n');
        buttons = [];
        for (const line of buttonLines) {
          if (line.includes('|')) {
            const [text, url] = line.split('|').map(s => s.trim());
            if (text && url) {
              buttons.push([{ text, url }]);
            }
          }
        }
      }
    }
    
    const replyMarkup = buttons ? { inline_keyboard: buttons } : null;
    
    let sent = 0;
    let failed = 0;
    
    for (const uid in db.users) {
      try {
        if (photo) {
          await bot.sendPhoto(uid, photo, { 
            caption: broadcastText,
            reply_markup: replyMarkup
          });
        } else {
          await bot.sendMessage(uid, broadcastText, {
            reply_markup: replyMarkup
          });
        }
        sent++;
      } catch (error) {
        failed++;
      }
    }
    
    bot.sendMessage(chatId, `✅ Рассылка завершена\n\n📤 Отправлено: ${sent}\n❌ Ошибок: ${failed}`);
    delete db.adminStates[userId];
    saveDB(db);
  }
  
  else if (adminState.action === 'user_info' && isAdmin(username)) {
    const targetUserId = parseInt(msg.text);
    const user = db.users[targetUserId];
    
    if (!user) {
      bot.sendMessage(chatId, '❌ Пользователь не найден');
    } else {
      const blockStatus = user.blocked ? '🚫 Заблокирован' : '✅ Активен';
      const info = `👤 Информация о пользователе\n\n`;
      const message = info + `🆔 ID: ${user.id}\n💰 Баланс: ${user.balance}\n👥 Рефералов: ${user.referrals.length}\n✅ Выполнено заданий: ${user.completedTasks.length}\n🛡 Статус: ${blockStatus}`;
      bot.sendMessage(chatId, message);
    }
    
    delete db.adminStates[userId];
    saveDB(db);
  }
  
  else if (adminState.action === 'add_robux' && isAdmin(username)) {
    const parts = msg.text.trim().split(/\s+/);
    if (parts.length !== 2) {
      bot.sendMessage(chatId, '❌ Неверный формат!\nИспользуйте: ID сумма');
      delete db.adminStates[userId];
      return;
    }
    
    const targetUserId = parseInt(parts[0]);
    const amount = parseFloat(parts[1]);
    
    if (isNaN(targetUserId) || isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, '❌ Неверные значения!');
      delete db.adminStates[userId];
      return;
    }
    
    const targetUser = getUser(targetUserId);
    targetUser.balance += amount;
    saveDB(db);
    
    bot.sendMessage(chatId, `✅ Добавлено ${amount} Робуксов пользователю ${targetUserId}\nНовый баланс: ${targetUser.balance}`);
    
    try {
      await bot.sendMessage(targetUserId, `🎉 Вам начислено ${amount} Робуксов!\n💰 Новый баланс: ${targetUser.balance}`);
    } catch (error) {
      // User blocked the bot
    }
    
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'remove_robux' && isAdmin(username)) {
    const parts = msg.text.trim().split(/\s+/);
    if (parts.length !== 2) {
      bot.sendMessage(chatId, '❌ Неверный формат!\nИспользуйте: ID сумма');
      delete db.adminStates[userId];
      return;
    }
    
    const targetUserId = parseInt(parts[0]);
    const amount = parseFloat(parts[1]);
    
    if (isNaN(targetUserId) || isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, '❌ Неверные значения!');
      delete db.adminStates[userId];
      return;
    }
    
    const targetUser = getUser(targetUserId);
    targetUser.balance = Math.max(0, targetUser.balance - amount);
    saveDB(db);
    
    bot.sendMessage(chatId, `✅ Убрано ${amount} Робуксов у пользователя ${targetUserId}\nНовый баланс: ${targetUser.balance}`);
    
    try {
      await bot.sendMessage(targetUserId, `⚠️ С вашего баланса снято ${amount} Робуксов\n💰 Новый баланс: ${targetUser.balance}`);
    } catch (error) {
      // User blocked the bot
    }
    
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'block_user' && isAdmin(username)) {
    const targetUserId = parseInt(msg.text);
    
    if (isNaN(targetUserId)) {
      bot.sendMessage(chatId, '❌ Неверный ID!');
      delete db.adminStates[userId];
      return;
    }
    
    const targetUser = getUser(targetUserId);
    if (targetUser.blocked) {
      bot.sendMessage(chatId, '⚠️ Пользователь уже заблокирован');
    } else {
      targetUser.blocked = true;
      saveDB(db);
      bot.sendMessage(chatId, `✅ Пользователь ${targetUserId} заблокирован`);
      
      try {
        await bot.sendMessage(targetUserId, '🚫 Вы были заблокированы администратором.\nДоступ к боту ограничен.');
      } catch (error) {
        // User blocked the bot
      }
    }
    
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'unblock_user' && isAdmin(username)) {
    const targetUserId = parseInt(msg.text);
    
    if (isNaN(targetUserId)) {
      bot.sendMessage(chatId, '❌ Неверный ID!');
      delete db.adminStates[userId];
      return;
    }
    
    const targetUser = getUser(targetUserId);
    if (!targetUser.blocked) {
      bot.sendMessage(chatId, '⚠️ Пользователь не заблокирован');
    } else {
      targetUser.blocked = false;
      saveDB(db);
      bot.sendMessage(chatId, `✅ Пользователь ${targetUserId} разблокирован`);
      
      try {
        await bot.sendMessage(targetUserId, '✅ Вы были разблокированы!\nТеперь вы можете снова использовать бот.');
      } catch (error) {
        // User blocked the bot
      }
    }
    
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_welcome' && isAdmin(username)) {
    db.settings.welcomeText = msg.text;
    saveDB(db);
    bot.sendMessage(chatId, '✅ Текст приветствия обновлен');
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_referral' && isAdmin(username)) {
    const reward = parseFloat(msg.text);
    if (isNaN(reward) || reward < 0) {
      bot.sendMessage(chatId, '❌ Введите корректное число');
    } else {
      db.settings.referralReward = reward;
      saveDB(db);
      bot.sendMessage(chatId, `✅ Награда за реферала установлена: ${reward} Робуксов`);
    }
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_about' && isAdmin(username)) {
    db.settings.aboutText = msg.text;
    saveDB(db);
    bot.sendMessage(chatId, '✅ Текст "О боте" обновлен');
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_penalty' && isAdmin(username)) {
    const penalty = parseFloat(msg.text);
    if (isNaN(penalty) || penalty < 0) {
      bot.sendMessage(chatId, '❌ Введите корректное число');
    } else {
      db.settings.unsubscribePenalty = penalty;
      saveDB(db);
      bot.sendMessage(chatId, `✅ Штраф за отписку установлен: ${penalty} Робуксов`);
    }
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_support' && isAdmin(username)) {
    db.settings.techSupport = msg.text;
    saveDB(db);
    bot.sendMessage(chatId, `✅ Тех. поддержка обновлена: ${msg.text}`);
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_channel_link' && isAdmin(username)) {
    db.settings.channelLink = msg.text.trim();
    saveDB(db);
    bot.sendMessage(chatId, `✅ Ссылка "Наш канал" обновлена: ${msg.text}`);
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_withdrawals_link' && isAdmin(username)) {
    db.settings.withdrawalsLink = msg.text.trim();
    saveDB(db);
    bot.sendMessage(chatId, `✅ Ссылка "Выводы" обновлена: ${msg.text}`);
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_giveaways_link' && isAdmin(username)) {
    db.settings.giveawaysLink = msg.text.trim();
    saveDB(db);
    bot.sendMessage(chatId, `✅ Ссылка "Розыгрыши" обновлена: ${msg.text}`);
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_withdraw_contact' && isAdmin(username)) {
    db.settings.supportContact = msg.text;
    saveDB(db);
    bot.sendMessage(chatId, `✅ Контакт для вывода обновлен: ${msg.text}`);
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_min_withdrawal' && isAdmin(username)) {
    const minAmount = parseInt(msg.text);
    if (isNaN(minAmount) || minAmount < 0 || !Number.isInteger(parseFloat(msg.text))) {
      bot.sendMessage(chatId, '❌ Введите корректное целое число');
    } else {
      db.settings.minWithdrawal = minAmount;
      saveDB(db);
      bot.sendMessage(chatId, `✅ Минимальная сумма вывода установлена: ${minAmount} Робуксов`);
    }
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'edit_admin_id' && isAdmin(username)) {
    const newAdminId = parseInt(msg.text);
    if (isNaN(newAdminId)) {
      bot.sendMessage(chatId, '❌ Введите корректный ID!');
    } else {
      db.settings.adminId = newAdminId;
      saveDB(db);
      bot.sendMessage(chatId, `✅ Admin ID установлен: ${newAdminId}`);
    }
    delete db.adminStates[userId];
  }
  
  
  // Handle withdrawal amount input from users
  else if (adminState.action === 'enter_promo') {
    const promoCode = msg.text.trim().toUpperCase();
    const user = getUser(userId);
    
    // Find promo
    const promo = db.promocodes.find(p => p.code === promoCode);
    
    if (!promo) {
      bot.sendMessage(chatId, '❌ Промокод не найден');
      delete db.adminStates[userId];
      return;
    }
    
    // Check if already used by this user
    if (user.usedPromocodes.includes(promoCode)) {
      bot.sendMessage(chatId, '❌ Вы уже использовали этот промокод');
      delete db.adminStates[userId];
      return;
    }
    
    // Check if max uses reached
    const usedCount = Object.values(db.users).filter(u => u.usedPromocodes && u.usedPromocodes.includes(promoCode)).length;
    if (usedCount >= promo.maxUses) {
      bot.sendMessage(chatId, '❌ Промокод исчерпан');
      delete db.adminStates[userId];
      return;
    }
    
    // Activate promocode
    user.activePromocode = {
      code: promoCode,
      bonus: promo.bonus,
      activatedAt: Date.now()
    };
    user.usedPromocodes.push(promoCode);
    saveDB(db);
    
    bot.sendMessage(chatId, `✅ Промокод активирован!\n\n🎫 Код: ${promoCode}\n📈 Бонус: +${promo.bonus}%\n\n💡 При следующем выводе вы получите +${promo.bonus}% к сумме вывода!`);
    delete db.adminStates[userId];
  }
  
  else if (adminState.action === 'withdraw_amount') {
    console.log(`[DEBUG] Withdrawal amount handler triggered for user ${userId}, username: ${username}`);
    console.log(`[DEBUG] Message text: ${msg.text}`);
    console.log(`[DEBUG] Admin state:`, adminState);
    const amount = parseInt(msg.text);
    const user = getUser(userId);
    const minAmount = db.settings.minWithdrawal || 100;
    
    if (isNaN(amount) || amount <= 0 || !Number.isInteger(parseFloat(msg.text))) {
      bot.sendMessage(chatId, '❌ Введите корректное целое число!');
      delete db.adminStates[userId];
      return;
    }
    
    if (amount < minAmount) {
      bot.sendMessage(chatId, `❌ Минимальная сумма для вывода: ${minAmount} Робуксов`);
      delete db.adminStates[userId];
      return;
    }
    
    if (amount > user.balance) {
      bot.sendMessage(chatId, `❌ Недостаточно средств!\n💰 Ваш баланс: ${user.balance} Робуксов`);
      delete db.adminStates[userId];
      return;
    }
    
    // Apply promocode bonus if active
    let finalAmount = amount;
    let promoInfo = null;
    if (user.activePromocode) {
      const bonusAmount = Math.floor(amount * user.activePromocode.bonus / 100);
      finalAmount = amount + bonusAmount;
      promoInfo = {
        code: user.activePromocode.code,
        bonus: user.activePromocode.bonus,
        bonusAmount: bonusAmount
      };
      // Remove active promocode after use
      delete user.activePromocode;
    }
    
    // Create withdrawal request
    const requestId = Date.now();
    const request = {
      id: requestId,
      userId: userId,
      username: username || 'No username',
      amount: finalAmount,
      originalAmount: amount,
      promocode: promoInfo,
      status: 'pending',
      timestamp: Date.now()
    };
    
    db.withdrawalRequests.push(request);
    user.balance -= amount;
    saveDB(db);
    
    let confirmMessage = `✅ Заявка на вывод создана!\n\n💸 Сумма: ${amount} Робуксов`;
    if (promoInfo) {
      confirmMessage += `\n🎫 Промокод: ${promoInfo.code} (+${promoInfo.bonus}%)\n📈 Бонус: +${promoInfo.bonusAmount} Робуксов\n💰 Итого к выводу: ${finalAmount} Робуксов`;
    }
    confirmMessage += `\n\n🕢 Заявка отправлена администратору.\n⏳ Ожидайте обработки...`;
    
    bot.sendMessage(chatId, confirmMessage);
    
    delete db.adminStates[userId];
    
    // Notify admin
    if (db.settings.adminId) {
      try {
        let adminMessage = `📥 Новая заявка на вывод!\n\n🆔 ID заявки: ${requestId}\n👤 Пользователь: @${username || 'No username'} (ID: ${userId})\n💸 Сумма: ${finalAmount} Робуксов`;
        if (promoInfo) {
          adminMessage += `\n🎫 Промокод: ${promoInfo.code} (+${promoInfo.bonus}%, +${promoInfo.bonusAmount} Robux)`;
        }
        
        await bot.sendMessage(db.settings.adminId, adminMessage, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Принять', callback_data: `approve_withdrawal_${requestId}` },
                { text: '❌ Отклонить', callback_data: `reject_withdrawal_${requestId}` }
              ]
            ]
          }
        });
        console.log(`[INFO] Withdrawal notification sent to admin ${db.settings.adminId}`);
      } catch (error) {
        console.error('[ERROR] Failed to notify admin:', error);
      }
    } else {
      console.error('[ERROR] Admin ID not set! Admin needs to start the bot first.');
    }
  }
});

// ============ ADMIN COMMANDS ============
bot.onText(/\/add_op_channel (.+)/, async (msg, match) => {
  const username = msg.from.username;
  if (!isAdmin(username)) return;
  
  const input = match[1].trim();
  const parts = input.split(/\s+/);
  
  if (parts.length < 2) {
    return bot.sendMessage(msg.chat.id, '❌ Неверный формат!\n\nИспользуйте:\n/add_op_channel @username Название\nили\n/add_op_channel https://t.me/+hash -1001234567890 Название\nили\n/add_op_channel -1001234567890 Название');
  }
  
  let channelIdentifier = parts[0];
  let chatIdProvided = null;
  let channelName;
  
  // Check if second parameter is a chat ID
  if (parts[1] && parts[1].match(/^-?\d+$/)) {
    chatIdProvided = parts[1];
    channelName = parts.slice(2).join(' ');
  } else {
    channelName = parts.slice(1).join(' ');
  }
  
  try {
    let chat;
    let channelUrl = null;
    let channelUsername = null;
    
    // If chat ID is provided, use it
    if (chatIdProvided) {
      chat = await bot.getChat(chatIdProvided);
      // Use the provided link if it's a private invite link
      if (channelIdentifier.includes('t.me/+') || channelIdentifier.includes('t.me/joinchat/')) {
        channelUrl = channelIdentifier;
      } else if (chat.username) {
        // Public channel
        channelUsername = `@${chat.username}`;
        channelUrl = `https://t.me/${chat.username}`;
      } else {
        // Private channel without provided link, try to get invite link
        try {
          channelUrl = await bot.exportChatInviteLink(chat.id);
        } catch (e) {
          channelUrl = null;
        }
      }
    } else if (channelIdentifier.match(/^-?\d+$/)) {
      // Direct chat ID without invite link
      chat = await bot.getChat(channelIdentifier);
      if (chat.username) {
        // Public channel
        channelUsername = `@${chat.username}`;
        channelUrl = `https://t.me/${chat.username}`;
      } else {
        // Private channel, try to get invite link
        try {
          channelUrl = await bot.exportChatInviteLink(chat.id);
        } catch (e) {
          channelUrl = null;
        }
      }
    } else if (channelIdentifier.includes('t.me/+') || channelIdentifier.includes('t.me/joinchat/')) {
      return bot.sendMessage(msg.chat.id, `🔗 Для приватных каналов укажите Chat ID:\n\n/add_op_channel ${channelIdentifier} -1001234567890 Название\n\n💡 Чтобы узнать Chat ID:\n1️⃣ Перешлите мне сообщение из канала\n2️⃣ Я покажу Chat ID`);
    } else {
      // Regular username
      chat = await bot.getChat(channelIdentifier);
      channelUsername = channelIdentifier;
      channelUrl = `https://t.me/${channelIdentifier.replace('@', '')}`;
    }
    
    const isBotAdminInChannel = await isBotAdmin(chat.id);
    
    if (!isBotAdminInChannel) {
      return bot.sendMessage(msg.chat.id, '❌ Бот не является администратором этого канала');
    }
    
    db.opChannels.push({
      id: chat.id,
      name: channelName,
      username: channelUsername,
      url: channelUrl
    });
    saveDB(db);
    
    bot.sendMessage(msg.chat.id, `✅ ОП канал добавлен: ${channelName}\n🆔 Chat ID: ${chat.id}\n💬 Название: ${chat.title}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${error.message}\n\nПроверьте:\n• Правильность username (@channel) или Chat ID\n• Бот добавлен в канал как админ`);
  }
});

// Add channel by Chat ID (for private channels)
bot.onText(/\/add_op_channel_by_id (-?\d+) (.+)/, async (msg, match) => {
  const username = msg.from.username;
  if (!isAdmin(username)) return;
  
  const chatId = match[1];
  const channelName = match[2];
  
  try {
    const chat = await bot.getChat(chatId);
    const isBotAdminInChannel = await isBotAdmin(chat.id);
    
    if (!isBotAdminInChannel) {
      return bot.sendMessage(msg.chat.id, '❌ Бот не является администратором этого канала');
    }
    
    // Get invite link if available
    let inviteLink = null;
    try {
      inviteLink = await bot.exportChatInviteLink(chat.id);
    } catch (e) {
      // Bot might not have permission to create invite link
    }
    
    db.opChannels.push({
      id: chat.id,
      name: channelName,
      username: chat.username ? `@${chat.username}` : null,
      url: inviteLink || (chat.username ? `https://t.me/${chat.username}` : null)
    });
    saveDB(db);
    
    bot.sendMessage(msg.chat.id, `✅ ОП канал добавлен: ${channelName}\n🆔 Chat ID: ${chat.id}\n💬 Название: ${chat.title}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${error.message}`);
  }
});

// Handler for forwarded messages to get Chat ID
bot.on('message', async (msg) => {
  if (!msg.forward_from_chat) return;
  if (!isAdmin(msg.from.username)) return;
  
  const forwardedChat = msg.forward_from_chat;
  
  if (forwardedChat.type === 'channel') {
    const isBotAdminInChannel = await isBotAdmin(forwardedChat.id);
    
    bot.sendMessage(msg.chat.id, `📊 Информация о канале:\n\n💬 Название: ${forwardedChat.title}\n🆔 Chat ID: ${forwardedChat.id}\n${forwardedChat.username ? `👤 Username: @${forwardedChat.username}` : '🔒 Приватный канал'}\n🤖 Бот - админ: ${isBotAdminInChannel ? '✅ Да' : '❌ Нет'}\n\nДля добавления канала используйте:\n/add_op_channel_by_id ${forwardedChat.id} Название`);
  }
});

bot.onText(/\/add_task/, async (msg) => {
  const username = msg.from.username;
  if (!isAdmin(username)) return;
  
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `📋 Создание нового задания

Отправьте данные в формате:
название | описание | награда | @канал1,@канал2,@канал3

Пример:
Подписаться на каналы | Подпишитесь на наши каналы | 50 | @channel1,@channel2`);
  
  db.adminStates = db.adminStates || {};
  db.adminStates[msg.from.id] = { action: 'create_task' };
  saveDB(db);
});

bot.onText(/\/add_promo ([A-Za-z0-9_]+) (\d+) (\d+)/, async (msg, match) => {
  const username = msg.from.username;
  if (!isAdmin(username)) {
    return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав администратора');
  }
  
  const code = match[1].toUpperCase();
  const bonus = parseInt(match[2]);
  const maxUses = parseInt(match[3]);
  
  // Check if promo already exists
  if (db.promocodes.find(p => p.code === code)) {
    return bot.sendMessage(msg.chat.id, `❌ Промокод "${code}" уже существует`);
  }
  
  if (bonus <= 0 || bonus > 100) {
    return bot.sendMessage(msg.chat.id, '❌ Бонус должен быть от 1 до 100%');
  }
  
  if (maxUses <= 0) {
    return bot.sendMessage(msg.chat.id, '❌ Количество использований должно быть больше 0');
  }
  
  db.promocodes.push({
    code: code,
    bonus: bonus,
    maxUses: maxUses,
    createdAt: Date.now()
  });
  saveDB(db);
  
  bot.sendMessage(msg.chat.id, `✅ Промокод создан!\n\n🎫 Код: ${code}\n📈 Бонус: +${bonus}%\n👥 Макс использований: ${maxUses}\n\n💡 Пользователи могут активировать его в профиле`);
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const userId = msg.from.id;
  const username = msg.from.username;
  const chatId = msg.chat.id;
  
  db.adminStates = db.adminStates || {};
  const adminState = db.adminStates[userId];
  
  if (adminState && adminState.action === 'create_task' && isAdmin(username)) {
    try {
      const parts = msg.text.split('|').map(p => p.trim());
      if (parts.length < 4) {
        return bot.sendMessage(chatId, '❌ Неверный формат. Используйте: название | описание | награда | каналы');
      }
      
      const [title, description, rewardStr, channelsStr] = parts;
      const reward = parseFloat(rewardStr);
      const channelUsernames = channelsStr.split(',').map(c => c.trim()).filter(c => c);
      
      if (isNaN(reward) || reward <= 0) {
        return bot.sendMessage(chatId, '❌ Награда должна быть положительным числом');
      }
      
      if (channelUsernames.length > 4) {
        return bot.sendMessage(chatId, '❌ Максимум 4 канала на задание');
      }
      
      const channels = [];
      for (const chInput of channelUsernames) {
        try {
          let chat;
          let channelUrl = null;
          let channelUsername = null;
          
          // Check if it's in format: link,id
          if (chInput.includes(',')) {
            const [link, id] = chInput.split(',').map(s => s.trim());
            chat = await bot.getChat(id);
            channelUrl = link;
          } else if (chInput.match(/^-?\d+$/)) {
            // Direct Chat ID
            chat = await bot.getChat(chInput);
            if (chat.username) {
              channelUsername = `@${chat.username}`;
              channelUrl = `https://t.me/${chat.username}`;
            } else {
              try {
                channelUrl = await bot.exportChatInviteLink(chat.id);
              } catch (e) {
                channelUrl = null;
              }
            }
          } else if (chInput.startsWith('@')) {
            // Username
            chat = await bot.getChat(chInput);
            channelUsername = chInput;
            channelUrl = `https://t.me/${chInput.replace('@', '')}`;
          } else {
            return bot.sendMessage(chatId, `❌ Неверный формат канала: ${chInput}\n\nИспользуйте:\n• @username\n• -1001234567890\n• https://t.me/+hash,-1001234567890`);
          }
          
          channels.push({
            id: chat.id,
            name: chat.title || channelUsername || `ID: ${chat.id}`,
            username: channelUsername,
            url: channelUrl
          });
        } catch (error) {
          return bot.sendMessage(chatId, `❌ Ошибка с каналом ${chInput}: ${error.message}`);
        }
      }
      
      const newTask = {
        id: db.tasks.length > 0 ? Math.max(...db.tasks.map(t => t.id)) + 1 : 1,
        title,
        description,
        reward,
        channels
      };
      
      db.tasks.push(newTask);
      saveDB(db);
      
      bot.sendMessage(chatId, `✅ Задание создано!\n\n📋 ${title}\n💰 Награда: ${reward} Робуксов\n📢 Каналов: ${channels.length}`);
      delete db.adminStates[userId];
    } catch (error) {
      bot.sendMessage(chatId, '❌ Ошибка создания задания: ' + error.message);
    }
  }
});

// ============ TASK SUBSCRIPTION CHECK (EVERY 5 MINUTES) ============
setInterval(async () => {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  const twoMinutes = 2 * 60 * 1000;
  
  for (const userId in db.users) {
    const user = db.users[userId];
    
    // Check every 5 minutes
    if (now - user.lastSubscriptionCheck >= fiveMinutes) {
      user.lastSubscriptionCheck = now;
      
      // Check all completed tasks
      for (const taskId of user.completedTasks) {
        const task = db.tasks.find(t => t.id === taskId);
        
        // If task was deleted, apply penalties for expired warnings, then clear
        if (!task) {
          if (user.taskWarnings[taskId]) {
            // Check if any warnings have expired (2 minutes passed)
            for (const channelId in user.taskWarnings[taskId]) {
              const warningTime = user.taskWarnings[taskId][channelId];
              if (now - warningTime >= twoMinutes) {
                // Warning expired - apply penalty
                user.balance = Math.max(0, user.balance - db.settings.unsubscribePenalty);
                
                try {
                  await bot.sendMessage(userId, `❌ Вы не подписались за 2 минуты!\n\n📎 Задание ID: ${taskId} (удалено)\n📢 Канал ID: ${channelId}\n\n💰 Штраф: -${db.settings.unsubscribePenalty} Робуксов\n💵 Текущий баланс: ${user.balance}`);
                } catch (error) {
                  // User blocked the bot
                }
              }
            }
            // Now clear all warnings for deleted task
            delete user.taskWarnings[taskId];
          }
          continue;
        }
        
        // Check each channel in the task
        for (const channel of task.channels) {
          const isSubscribed = await checkSubscription(parseInt(userId), channel.id);
          
          if (!isSubscribed) {
            // Initialize task warnings if not exists
            if (!user.taskWarnings[taskId]) {
              user.taskWarnings[taskId] = {};
            }
            
            // Check if there's already a warning for this channel
            if (user.taskWarnings[taskId][channel.id]) {
              // Check if 2 minutes have passed since warning
              const warningTime = user.taskWarnings[taskId][channel.id];
              if (now - warningTime >= twoMinutes) {
                // Apply penalty
                user.balance = Math.max(0, user.balance - db.settings.unsubscribePenalty);
                
                try {
                  await bot.sendMessage(userId, `❌ Вы не подписались за 2 минуты!\n\n📎 Задание: ${task.title}\n📢 Канал: ${channel.name}\n\n💰 Штраф: -${db.settings.unsubscribePenalty} Робуксов\n💵 Текущий баланс: ${user.balance}`);
                } catch (error) {
                  // User blocked the bot
                }
                
                // Clear warning after penalty
                delete user.taskWarnings[taskId][channel.id];
              }
            } else {
              // First time detecting unsubscribe - send warning
              user.taskWarnings[taskId][channel.id] = now;
              
              try {
                const keyboard = {
                  inline_keyboard: [
                    [{ text: `📢 Подписаться на ${channel.name}`, url: channel.url }],
                    [{ text: '✅ Я подписался', callback_data: `recheck_task_${taskId}` }]
                  ]
                };
                
                await bot.sendMessage(userId, `⚠️ ПРЕДУПРЕЖДЕНИЕ!\n\nВы отписались от канала в выполненном задании!\n\n📎 Задание: ${task.title}\n📢 Канал: ${channel.name}\n\n⏰ У вас есть 2 минуты чтобы подписаться снова!\n💰 Иначе будет штраф: ${db.settings.unsubscribePenalty} Робуксов`, { reply_markup: keyboard });
              } catch (error) {
                // User blocked the bot
              }
            }
          } else {
            // User is subscribed - clear any warnings
            if (user.taskWarnings[taskId] && user.taskWarnings[taskId][channel.id]) {
              delete user.taskWarnings[taskId][channel.id];
            }
          }
        }
        
        // Clean up empty task warnings
        if (user.taskWarnings[taskId] && Object.keys(user.taskWarnings[taskId]).length === 0) {
          delete user.taskWarnings[taskId];
        }
      }
      
      saveDB(db);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

console.log('⏰ Проверка подписок на задания запущена (каждые 5 минут)');
console.log('⚠️ Предупреждение при отписке: 2 минуты на повторную подписку');

console.log('✅ Bot started successfully!');
console.log(`Admin: @${ADMIN_USERNAME}`);
