/**
 * エニアグラムセッション 予約バックエンド
 * 予約ページ(GitHub Pages) ← → GAS ← → Zoom / Googleカレンダー / Gmail
 *
 * 【流れ】
 *   申込 → 枠を仮押さえ＋PayPalのURLを自動返信
 *        → 入金を確認したら、通知メールの「確定する」リンクをタップ
 *        → Zoom発行・確定メール送信・カレンダーを本予約に更新
 *        → 前日にリマインド自動送信
 *   期限までに入金がなければ、催促を1回送ったあと自動で枠を開放します。
 *
 * 【セットアップは README.md を見てね】
 */

// ============================================================
// ここだけ直せばOK
// ============================================================
const CONFIG = {
  // --- セッションの中身 ---
  TITLE: 'エニアグラムセッション',
  DURATION_MIN: 60,        // 所要時間（分）
  PRICE: 7700,             // 税込価格（円）

  // --- お支払い ---
  // ★さっちゃんがPayPalで作った支払いURLをここに貼る（毎回これを案内します）
  PAYPAL_URL: 'https://www.paypal.com/ncp/payment/GMXHDH8KTPRVJ',
  PAYMENT_DEADLINE_DAYS: 3,   // 申込から何日以内に入金してもらうか
  BANK_INFO: '',              // 銀行振込も受けるなら口座を書く。空なら案内しない

  // --- 予約枠の作り方 ---
  // 0=日 1=月 2=火 3=水 4=木 5=金 6=土　空配列 [] にすればその曜日は受付なし
  BUSINESS_HOURS: {
    0: [],                                        // 日曜は受付なし
    1: [['10:00', '15:00'], ['21:00', '23:00']],  // 月
    2: [['10:00', '15:00'], ['21:00', '23:00']],  // 火
    3: [['10:00', '15:00'], ['21:00', '23:00']],  // 水
    4: [['10:00', '15:00'], ['21:00', '23:00']],  // 木
    5: [['10:00', '15:00'], ['21:00', '23:00']],  // 金
    6: [['10:00', '12:00']]                       // 土
  },
  SLOT_STEP_MIN: 30,       // 枠の刻み（30なら 10:00, 10:30, 11:00…）
  BUFFER_MIN: 15,          // セッションの前後に空ける時間（分）
  LEAD_TIME_HOURS: 48,     // 何時間先から予約できるか（入金を待つので48時間にしてある）
  MAX_DAYS_AHEAD: 21,      // 何日先まで予約できるか

  // --- カレンダー ---
  // 'primary' はメインカレンダー。ここに入っている予定は自動でブロックされる
  //（＝予約を受けたくない日は、普通に予定を入れればOK）
  CALENDAR_ID: 'primary',

  // --- 連絡先・文面 ---
  ADMIN_EMAIL: 'andante.no.satchan@gmail.com',
  FROM_NAME: 'さっちゃん（あんだんて）',
  LINE_URL: 'https://lin.ee/yxYXouv',
  LEGAL_URL: 'https://satchan-cocoro.github.io/enneagram-session/legal.html',

  REMIND_DAYS_BEFORE: 1,   // 何日前にリマインドを送るか
  TZ: 'Asia/Tokyo'
};

// 申込フォームで聞く質問（増やしたければここに足す）
// key は英数字、type は 'text' | 'date' | 'time' | 'select' | 'textarea'
const QUESTIONS = [
  { key: 'topic', label: '当日いちばん話したいこと', type: 'textarea', required: true,
    note: 'ざっくりで大丈夫！ここを先に読んでから当日を迎えます' },
  { key: 'known', label: 'さっちゃんを知ったきっかけ', type: 'select', required: false,
    options: ['Instagram', '公式LINE', 'X（旧Twitter）', 'Threads', 'オープンチャット',
              'Substack', 'note', 'YouTube', 'ご紹介・口コミ', 'その他'] }
];

/**
 * 流入経路の自動計測。
 * 予約ページのURLに ?from=line のように付けておくと、そのまま記録されます。
 * 例）公式LINEに貼るURL … https://satchan-cocoro.github.io/enneagram-session/?from=line
 * 「どこで知ったか」（本人の記憶）と「どこから来たか」（実際の導線）は別物なので、両方残しています。
 */
const FROM_LABELS = {
  line:      '公式LINE',
  story:     'Instagramストーリー',
  ig:        'Instagram投稿・リール',
  pochirep:  'ポチリプ（Instagram自動返信）',
  x:         'X（旧Twitter）',
  threads:   'Threads',
  opechat:   'オープンチャット',
  substack:  'Substack',
  note:      'note',
  youtube:   'YouTube',
  lp:        'LP・無料講座'
};

const PROPS = PropertiesService.getScriptProperties();
const SHEET_NAME = '予約ログ';
const HEADERS = ['受付日時', '予約ID', 'お名前', 'メール', '日時', '終了', '金額',
                 '入金確認', 'ステータス', '支払期限', 'ZoomURL', 'カレンダーID',
                 '催促送信', 'リマインド送信', '回答', '流入経路', '確定トークン'];
const ST = { UNPAID: '入金待ち', DONE: '確定', CANCEL: 'キャンセル', EXPIRED: '期限切れ' };

// ============================================================
// Web API
// ============================================================
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action || 'config';
    if (action === 'config')  return json_(getPublicConfig_());
    if (action === 'slots')   return json_({ ok: true, slots: listOpenSlots_() });
    // ↓ さっちゃんが通知メールからタップする用（ブラウザで開く）
    if (action === 'confirm') return html_(actConfirm_(p.t));
    if (action === 'release') return html_(actRelease_(p.t));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  // ブラウザからは Content-Type: text/plain で送る（GASはプリフライトを返せないため）
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  if (body.action !== 'book') return json_({ ok: false, error: 'unknown action' });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: '混み合っています。少し待ってからもう一度お試しください。' });
  }
  try {
    return json_(book_(body));
  } catch (err) {
    logError_('book', err, body);
    return json_({ ok: false, error: '受付処理でエラーが起きました。お手数ですが公式LINEからご連絡ください。' });
  } finally {
    lock.releaseLock();
  }
}

function getPublicConfig_() {
  return {
    ok: true,
    title: CONFIG.TITLE,
    durationMin: CONFIG.DURATION_MIN,
    price: CONFIG.PRICE,
    paypalUrl: CONFIG.PAYPAL_URL,
    deadlineDays: CONFIG.PAYMENT_DEADLINE_DAYS,
    bankInfo: CONFIG.BANK_INFO,
    questions: QUESTIONS,
    lineUrl: CONFIG.LINE_URL,
    legalUrl: CONFIG.LEGAL_URL
  };
}

// ============================================================
// 空き枠の計算
// ============================================================
function listOpenSlots_() {
  const cal = getCalendar_();
  const now = new Date();
  const start = new Date(now.getTime() + CONFIG.LEAD_TIME_HOURS * 3600 * 1000);
  const end = new Date(now.getTime() + CONFIG.MAX_DAYS_AHEAD * 24 * 3600 * 1000);

  // 既存の予定（仮押さえ分もカレンダーに入っているので、そのままブロックされる）
  const busy = cal.getEvents(
    new Date(start.getTime() - 24 * 3600 * 1000),
    new Date(end.getTime() + 24 * 3600 * 1000)
  ).map(function (ev) {
    return { start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() };
  });

  const out = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  while (cursor.getTime() <= end.getTime()) {
    const ranges = CONFIG.BUSINESS_HOURS[cursor.getDay()] || [];
    for (let r = 0; r < ranges.length; r++) {
      const from = atTime_(cursor, ranges[r][0]);
      const to   = atTime_(cursor, ranges[r][1]);
      for (let t = from.getTime(); t + CONFIG.DURATION_MIN * 60000 <= to.getTime();
           t += CONFIG.SLOT_STEP_MIN * 60000) {
        const eMs = t + CONFIG.DURATION_MIN * 60000;
        if (t < start.getTime()) continue;
        if (isBusy_(t, eMs, busy)) continue;
        out.push({
          iso: new Date(t).toISOString(),
          date: Utilities.formatDate(new Date(t), CONFIG.TZ, 'yyyy-MM-dd'),
          label: fmtDateTime_(new Date(t))
        });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function isBusy_(startMs, endMs, busy) {
  const b = CONFIG.BUFFER_MIN * 60000;
  for (let i = 0; i < busy.length; i++) {
    if (startMs - b < busy[i].end && endMs + b > busy[i].start) return true;
  }
  return false;
}

function slotStillOpen_(startDate) {
  const slots = listOpenSlots_();
  const want = startDate.toISOString();
  for (let i = 0; i < slots.length; i++) if (slots[i].iso === want) return true;
  return false;
}

// ============================================================
// ① 申込 → 枠を仮押さえして、支払いURLを送る
// ============================================================
function book_(body) {
  const name  = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const slotIso = String(body.slot || '').trim();

  if (!name)  return { ok: false, error: 'お名前を入力してください' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'メールアドレスの形式をご確認ください' };
  if (!slotIso) return { ok: false, error: '日時が選ばれていません' };

  const answers = body.answers || {};
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    if (q.required && !String(answers[q.key] || '').trim()) {
      return { ok: false, error: q.label + 'を入力してください' };
    }
  }

  const from = cleanFrom_(body.from);

  const startAt = new Date(slotIso);
  if (isNaN(startAt.getTime())) return { ok: false, error: '日時の形式が正しくありません' };
  const endAt = new Date(startAt.getTime() + CONFIG.DURATION_MIN * 60000);

  if (!slotStillOpen_(startAt)) {
    return { ok: false, error: 'ごめんなさい、たった今その枠が埋まってしまいました。別の日時を選び直してください。' };
  }

  const id = newId_();
  const token = newId_() + newId_();   // 確定リンク用。お客さまには渡さない
  const deadline = calcDeadline_(startAt);

  // カレンダーに【仮】で入れる → この時点で他の人からは枠が消える
  let eventId = '';
  try {
    eventId = createHoldEvent_(id, name, email, startAt, endAt, answers, deadline);
  } catch (err) {
    logError_('calendar-hold', err, { id: id });
    return { ok: false, error: '受付処理でエラーが起きました。お手数ですが公式LINEからご連絡ください。' };
  }

  appendLog_({
    id: id, token: token, name: name, email: email, startAt: startAt, endAt: endAt,
    deadline: deadline, eventId: eventId, answers: answers, from: from
  });

  try { sendPaymentMail_(name, email, startAt, deadline, id); }
  catch (err) { logError_('mail-payment', err, { id: id }); }
  try { sendAdminNewMail_(token, name, email, startAt, answers, deadline, from); }
  catch (err) { logError_('mail-admin', err, { id: id }); }
  discordNew_(token, name, email, startAt, answers, deadline, from);

  return {
    ok: true,
    when: fmtDateTime_(startAt),
    deadline: fmtDateTime_(deadline),
    paypalUrl: CONFIG.PAYPAL_URL,
    price: CONFIG.PRICE
  };
}

/** ?from= の値を安全な形にそろえる（英数字・ハイフン・アンダースコアだけ、32文字まで） */
function cleanFrom_(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return s.slice(0, 32);
}

/** 流入経路を人が読める形に（未登録のキーはそのまま出す） */
function fromLabel_(from) {
  if (!from) return '';
  return FROM_LABELS[from] ? (FROM_LABELS[from] + '（' + from + '）') : from;
}

/** 支払期限＝申込からN日後。ただしセッション開始の24時間前を超えないようにする */
function calcDeadline_(startAt) {
  const byDays = new Date(Date.now() + CONFIG.PAYMENT_DEADLINE_DAYS * 24 * 3600 * 1000);
  const beforeSession = new Date(startAt.getTime() - 24 * 3600 * 1000);
  return byDays.getTime() < beforeSession.getTime() ? byDays : beforeSession;
}

// ============================================================
// ② 入金を確認したら確定（通知メールのリンクから）
// ============================================================
function actConfirm_(token) {
  if (!token) return page_('リンクが正しくありません', '');
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return page_('混み合っています', 'もう一度開いてください。'); }
  try {
    const r = findByToken_(token);
    if (!r) return page_('見つかりません', 'この予約は見つかりませんでした。リンクが古い可能性があります。');
    if (r.get('ステータス') === ST.DONE) {
      return page_('すでに確定しています', r.get('お名前') + '様／' + fmtDateTime_(r.get('日時')) +
        '<br>お客さまへの確定メールは送信済みです。');
    }
    if (r.get('ステータス') === ST.CANCEL || r.get('ステータス') === ST.EXPIRED) {
      return page_('この予約は終了しています', '状態：' + r.get('ステータス') +
        '<br>確定したい場合は、スプレッドシートのステータスを「' + ST.UNPAID + '」に戻してから、もう一度このリンクを開いてください。');
    }
    const res = confirmBooking_(r);
    return page_('確定しました！',
      r.get('お名前') + '様／' + fmtDateTime_(r.get('日時')) +
      '<br>お客さまに確定メール（Zoom URL入り）を送りました。' +
      (res.zoomUrl ? '' : '<br><br>⚠ Zoomの発行に失敗しました。手動でURLを作って送ってください。'));
  } catch (err) {
    logError_('confirm', err, {});
    return page_('エラーが起きました', String(err && err.message || err));
  } finally {
    lock.releaseLock();
  }
}

function confirmBooking_(r) {
  const name = r.get('お名前');
  const email = r.get('メール');
  const startAt = r.get('日時');
  const endAt = r.get('終了');
  const answers = safeParse_(r.get('回答'));

  let zoomUrl = '', zoomPass = '';
  try {
    const zm = zoomCreateMeeting_(name, startAt);
    zoomUrl = zm.join_url;
    zoomPass = zm.password || '';
  } catch (err) {
    logError_('zoom', err, { id: r.get('予約ID') });
  }

  // カレンダーの【仮】を本予約に更新
  try {
    const ev = getCalendar_().getEventById(r.get('カレンダーID'));
    if (ev) {
      ev.setTitle(CONFIG.TITLE + '／' + name + '様');
      ev.setDescription(eventBody_(r.get('予約ID'), name, email, answers,
        '入金確認済み（' + yen_(CONFIG.PRICE) + '）', zoomUrl));
      try { ev.addEmailReminder(60); } catch (e) {}
    }
  } catch (err) {
    logError_('calendar-confirm', err, { id: r.get('予約ID') });
  }

  r.set('ステータス', ST.DONE);
  r.set('入金確認', true);
  r.set('ZoomURL', zoomUrl);

  try { sendConfirmMail_(name, email, startAt, zoomUrl, zoomPass); }
  catch (err) { logError_('mail-confirm', err, { id: r.get('予約ID') }); }

  discordConfirmed_(name, startAt, zoomUrl);
  return { zoomUrl: zoomUrl };
}

/** 枠を開放する（キャンセル・入金なしのとき） */
function actRelease_(token) {
  if (!token) return page_('リンクが正しくありません', '');
  const r = findByToken_(token);
  if (!r) return page_('見つかりません', 'この予約は見つかりませんでした。リンクが古い可能性があります。');
  releaseRow_(r, ST.CANCEL);
  return page_('枠を開放しました',
    r.get('お名前') + '様／' + fmtDateTime_(r.get('日時')) +
    '<br>カレンダーの仮押さえを消して、予約ページに枠を戻しました。' +
    '<br><small>※お客さまへの連絡は送っていません。必要ならメールしてください。</small>');
}

function releaseRow_(r, status) {
  try {
    const ev = getCalendar_().getEventById(r.get('カレンダーID'));
    if (ev) ev.deleteEvent();
  } catch (err) {
    logError_('calendar-release', err, { id: r.get('予約ID') });
  }
  r.set('ステータス', status);
}

// ============================================================
// ③ 毎日まわす（催促・期限切れ・リマインド）
// ============================================================
function dailyJob() {
  expireUnpaid_();
  sendPaymentNudge_();
  sendReminders();
}

/** 期限を過ぎた入金待ちの枠を開放する */
function expireUnpaid_() {
  eachRow_(function (r) {
    if (r.get('ステータス') !== ST.UNPAID) return;
    const dl = r.get('支払期限');
    if (!(dl instanceof Date)) return;
    if (dl.getTime() >= Date.now()) return;

    releaseRow_(r, ST.EXPIRED);
    try {
      MailApp.sendEmail({
        to: r.get('メール'),
        subject: '【期限切れ】' + CONFIG.TITLE + 'の仮のお席について',
        name: CONFIG.FROM_NAME,
        replyTo: CONFIG.ADMIN_EMAIL,
        body: [
          r.get('お名前') + '様',
          '',
          'さっちゃんです。',
          fmtDateTime_(r.get('日時')) + ' でお取りしていた仮のお席ですが、',
          'お支払いの確認ができなかったため、いったん枠を戻させていただきました。',
          '',
          'もし「入れ違いで振り込んだ！」ということでしたら、このメールに返信してくださいね。すぐ確認します。',
          '改めてご希望の場合も、遠慮なく声をかけてください♡',
          '',
          CONFIG.FROM_NAME
        ].join('\n')
      });
    } catch (err) { logError_('mail-expire', err, { id: r.get('予約ID') }); }

    try {
      MailApp.sendEmail({
        to: CONFIG.ADMIN_EMAIL,
        subject: '[期限切れ] ' + r.get('お名前') + '様 ' + fmtDateShort_(r.get('日時')),
        body: '入金がなかったので枠を開放しました。\n入れ違いだった場合は、スプレッドシートのステータスを「'
              + ST.UNPAID + '」に戻して、通知メールの確定リンクを開いてください。'
      });
    } catch (err) {}

    discordExpired_(r.get('お名前'), r.get('日時'));
  });
}

/** 期限が明日に迫っている入金待ちに、1回だけ催促を送る */
function sendPaymentNudge_() {
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 24 * 3600 * 1000), CONFIG.TZ, 'yyyy-MM-dd');
  eachRow_(function (r) {
    if (r.get('ステータス') !== ST.UNPAID) return;
    if (r.get('催促送信') === '済') return;
    const dl = r.get('支払期限');
    if (!(dl instanceof Date)) return;
    if (Utilities.formatDate(dl, CONFIG.TZ, 'yyyy-MM-dd') !== tomorrow) return;

    try {
      MailApp.sendEmail({
        to: r.get('メール'),
        subject: '【あと1日】' + CONFIG.TITLE + 'のお支払いについて',
        name: CONFIG.FROM_NAME,
        replyTo: CONFIG.ADMIN_EMAIL,
        body: [
          r.get('お名前') + '様',
          '',
          'さっちゃんです。お申し込みありがとうございます！',
          '',
          fmtDateTime_(r.get('日時')) + ' のお席を仮でお取りしています。',
          'お支払いの確認がまだ取れていないので、念のためのお知らせです。',
          '',
          '──────────────',
          '■ 金額：' + yen_(CONFIG.PRICE) + '（税込）',
          '■ お支払い：' + CONFIG.PAYPAL_URL,
          '■ お手続き期限：' + fmtDateTime_(dl),
          '──────────────',
          '',
          '期限を過ぎると、いったん枠を他の方に戻すことになります。',
          'もう振り込んでくださっていたら、行き違いです。ごめんなさい！このメールに返信で教えてください。',
          '',
          '日程を変えたい・やっぱり難しい、というのも大丈夫です。ひとこと返信してくださいね。',
          '',
          CONFIG.FROM_NAME
        ].join('\n')
      });
      r.set('催促送信', '済');
    } catch (err) { logError_('mail-nudge', err, { id: r.get('予約ID') }); }
  });
}

/** 前日リマインド（確定済みだけ） */
function sendReminders() {
  const target = Utilities.formatDate(
    new Date(Date.now() + CONFIG.REMIND_DAYS_BEFORE * 24 * 3600 * 1000), CONFIG.TZ, 'yyyy-MM-dd');

  eachRow_(function (r) {
    if (r.get('ステータス') !== ST.DONE) return;
    if (r.get('リマインド送信') === '済') return;
    const startAt = r.get('日時');
    if (!(startAt instanceof Date)) return;
    if (Utilities.formatDate(startAt, CONFIG.TZ, 'yyyy-MM-dd') !== target) return;

    try {
      MailApp.sendEmail({
        to: r.get('メール'),
        subject: '【明日です】' + CONFIG.TITLE + '／' + fmtDateShort_(startAt),
        name: CONFIG.FROM_NAME,
        replyTo: CONFIG.ADMIN_EMAIL,
        body: [
          r.get('お名前') + '様',
          '',
          'こんにちは、さっちゃんです！',
          'いよいよ明日ですね。楽しみにしています♡',
          '',
          '──────────────',
          '■ ' + CONFIG.TITLE,
          '■ 日時：' + fmtDateTime_(startAt) + '（' + CONFIG.DURATION_MIN + '分）',
          '■ 参加URL：' + (r.get('ZoomURL') || '別途お送りします'),
          '──────────────',
          '',
          '・時間になったら上のURLをクリックするだけでOKです',
          '・お顔出しなしでも大丈夫',
          '・イヤホンがあると聞き取りやすいです',
          '',
          '「うまく話せるかな」と思わなくて大丈夫。',
          'まとまっていない状態のまま持ってきてください。そこから一緒にほどいていきます！',
          '',
          '当日どうしても難しくなったら、このメールに返信してくださいね。',
          '',
          CONFIG.FROM_NAME
        ].join('\n')
      });
      r.set('リマインド送信', '済');
    } catch (err) { logError_('mail-remind', err, { id: r.get('予約ID') }); }
  });
}

// ============================================================
// メール文面
// ============================================================
function sendPaymentMail_(name, email, startAt, deadline, id) {
  const body = [
    name + '様',
    '',
    'お申し込みありがとうございます！',
    'さっちゃん（髙橋さつき）です。',
    '',
    '下記の日時で、お席を仮でお取りしました。',
    '**お支払いの確認をもって、ご予約が確定します。**',
    '',
    '──────────────',
    '■ ' + CONFIG.TITLE,
    '■ 日時：' + fmtDateTime_(startAt) + '（' + CONFIG.DURATION_MIN + '分）',
    '■ 受講料：' + yen_(CONFIG.PRICE) + '（税込）',
    '──────────────',
    '',
    '【お支払いはこちらから】',
    CONFIG.PAYPAL_URL,
    '',
    CONFIG.BANK_INFO ? ('【銀行振込をご希望の場合】\n' + CONFIG.BANK_INFO + '\n') : '',
    'お手続きの期限：' + fmtDateTime_(deadline),
    '※期限を過ぎると、いったん枠を他の方に戻させていただきます',
    '',
    'お支払いを確認しましたら、',
    '当日のZoom URLを入れた「確定メール」を改めてお送りします。',
    '（私が手で確認しているので、少しお時間をいただくことがあります。翌日になっても届かないときは遠慮なくつついてください！）',
    '',
    '日程の変更やキャンセルは、このメールにそのまま返信してくださいね。',
    '公式LINEからでもOKです → ' + CONFIG.LINE_URL,
    '',
    'お会いできるのを楽しみにしています♡',
    '',
    CONFIG.FROM_NAME,
    CONFIG.ADMIN_EMAIL,
    '受付番号：' + id,
    '特定商取引法に基づく表記：' + CONFIG.LEGAL_URL
  ].filter(function (v) { return v !== ''; }).join('\n');

  MailApp.sendEmail({
    to: email,
    subject: '【お支払いのご案内】' + CONFIG.TITLE + '／' + fmtDateShort_(startAt),
    body: body,
    name: CONFIG.FROM_NAME,
    replyTo: CONFIG.ADMIN_EMAIL
  });
}

function sendConfirmMail_(name, email, startAt, zoomUrl, zoomPass) {
  const body = [
    name + '様',
    '',
    'お支払いを確認しました。ありがとうございます！',
    'ご予約が確定しました♡',
    '',
    '──────────────',
    '■ ' + CONFIG.TITLE,
    '■ 日時：' + fmtDateTime_(startAt) + '（' + CONFIG.DURATION_MIN + '分）',
    '■ 参加URL：' + (zoomUrl || '準備でき次第、改めてお送りします'),
    zoomPass ? ('■ パスコード：' + zoomPass) : '',
    '──────────────',
    '',
    '【当日までにお願いしたいこと】',
    '・上のURLは当日そのままクリックすればつながります',
    '・お顔出しなしでも大丈夫です',
    '・静かに話せる場所と、イヤホンがあると聞きやすいです',
    '',
    '前日にもう一度リマインドをお送りしますね。',
    '',
    '日程の変更は前日まで承ります。このメールに返信してください。',
    '',
    'それでは当日、お待ちしています！',
    '',
    CONFIG.FROM_NAME,
    CONFIG.ADMIN_EMAIL
  ].filter(function (v) { return v !== ''; }).join('\n');

  MailApp.sendEmail({
    to: email,
    subject: '【ご予約確定】' + CONFIG.TITLE + '／' + fmtDateShort_(startAt),
    body: body,
    name: CONFIG.FROM_NAME,
    replyTo: CONFIG.ADMIN_EMAIL
  });
}

function sendAdminNewMail_(token, name, email, startAt, answers, deadline, from) {
  const base = webAppUrl_();
  const lines = [
    '新しいお申し込みが入りました（まだ入金待ちです）。',
    '',
    '日時: ' + fmtDateTime_(startAt),
    '名前: ' + name,
    'メール: ' + email,
    '金額: ' + yen_(CONFIG.PRICE),
    '支払期限: ' + fmtDateTime_(deadline),
    '',
    '━━━━━━━━━━━━━━━━━━',
    'PayPalに入金が入っていたら、↓をタップするだけで',
    'Zoom発行 → 確定メール送信 まで自動で終わります。',
    '',
    '▼ 入金を確認した（確定する）',
    base ? (base + '?action=confirm&t=' + token) : '（ウェブアプリURLが未登録です。setUpWebAppUrl を実行してください）',
    '',
    '▼ この予約をやめて枠を戻す',
    base ? (base + '?action=release&t=' + token) : '',
    '━━━━━━━━━━━━━━━━━━',
    ''
  ];
  QUESTIONS.forEach(function (q) {
    lines.push('【' + q.label + '】' + (prettyAnswer_(q, answers) || '—'));
  });
  if (fromLabel_(from)) lines.push('【どこから来たか】' + fromLabel_(from));
  MailApp.sendEmail({
    to: CONFIG.ADMIN_EMAIL,
    subject: '[入金待ち] ' + name + '様 ' + fmtDateShort_(startAt),
    body: lines.filter(function (v) { return v !== ''; }).join('\n')
  });
}

// ============================================================
// Discord通知
// ============================================================
/**
 * Discordのウェブフックに飛ばす。
 * 失敗しても本処理は止めない。ここから logError_ は呼ばないこと（通知が失敗すると無限に回るため）。
 */
function notifyDiscord_(embed, content) {
  const url = PROPS.getProperty('DISCORD_WEBHOOK_URL');
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        username: 'エニアグラム予約',
        content: content || '',
        embeds: embed ? [embed] : [],
        allowed_mentions: { parse: [] }
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('discord通知に失敗', err);
  }
}

/** 回答を人が読める形に整える（1990-11-03 → 1990年11月3日） */
function prettyAnswer_(q, answers) {
  const v = String((answers || {})[q.key] || '').trim();
  if (!v) return '';
  if (q.type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return Number(m[1]) + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
  }
  if (q.type === 'time') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (m) return Number(m[1]) + '時' + m[2] + '分ごろ';
  }
  return v;
}

function fld_(name, value, inline) {
  return { name: name, value: String(value || '—').slice(0, 1000), inline: !!inline };
}

/** 新しい申込が入ったとき（入金待ち） */
function discordNew_(token, name, email, startAt, answers, deadline, from) {
  const base = webAppUrl_();
  const links = base
    ? ('**[✅ 入金を確認した（確定する）](' + base + '?action=confirm&t=' + token + ')**\n' +
       '[🗑 この予約をやめて枠を戻す](' + base + '?action=release&t=' + token + ')')
    : '⚠ ウェブアプリURLが未登録です（`setUpWebAppUrl` を実行してください）';

  const fields = [
    fld_('日時', fmtDateTime_(startAt), true),
    fld_('金額', yen_(CONFIG.PRICE), true),
    fld_('お名前', name + ' 様', true),
    fld_('メール', email, true),
    fld_('支払期限', fmtDateTime_(deadline), false)
  ];
  QUESTIONS.forEach(function (q) {
    const v = prettyAnswer_(q, answers);
    if (v) fields.push(fld_(q.label, v, false));
  });
  if (fromLabel_(from)) fields.push(fld_('どこから来たか', fromLabel_(from), false));
  fields.push(fld_('入金を確認したら', links, false));

  notifyDiscord_({
    title: '🕐 入金待ちの申込が入りました',
    description: 'PayPalに入金が入っていたら、下のリンクをタップするだけで確定できます。',
    color: 0xE8956D,
    fields: fields,
    footer: { text: CONFIG.TITLE }
  });
}

/** 確定したとき */
function discordConfirmed_(name, startAt, zoomUrl) {
  notifyDiscord_({
    title: '✅ 予約が確定しました',
    color: 0x3E8E6E,
    fields: [
      fld_('日時', fmtDateTime_(startAt), true),
      fld_('お名前', name + ' 様', true),
      fld_('Zoom', zoomUrl || '⚠ 発行に失敗。手動でURLを作って送ってください', false)
    ],
    footer: { text: 'お客さまに確定メールを送信済み' }
  });
}

/** 期限切れで枠を戻したとき */
function discordExpired_(name, startAt) {
  notifyDiscord_({
    title: '⏰ 入金がなかったので枠を戻しました',
    color: 0x9E9E9E,
    fields: [
      fld_('日時', fmtDateTime_(startAt), true),
      fld_('お名前', name + ' 様', true)
    ],
    footer: { text: '入れ違いだった場合はスプレッドシートのステータスを「' + ST.UNPAID + '」に戻してください' }
  });
}

// ============================================================
// Zoom（Server-to-Server OAuth）
// ============================================================
function zoomToken_() {
  const acc = PROPS.getProperty('ZOOM_ACCOUNT_ID');
  const id  = PROPS.getProperty('ZOOM_CLIENT_ID');
  const sec = PROPS.getProperty('ZOOM_CLIENT_SECRET');
  if (!acc || !id || !sec) throw new Error('Zoomの設定が未登録です');
  const res = UrlFetchApp.fetch(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(acc), {
      method: 'post',
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + sec) },
      muteHttpExceptions: true
    });
  const data = JSON.parse(res.getContentText());
  if (!data.access_token) throw new Error('Zoom認証に失敗しました: ' + res.getContentText());
  return data.access_token;
}

function zoomCreateMeeting_(name, startAt) {
  const token = zoomToken_();
  const res = UrlFetchApp.fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      topic: CONFIG.TITLE + '（' + name + '様）',
      type: 2,
      start_time: Utilities.formatDate(startAt, CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ss"),
      timezone: CONFIG.TZ,
      duration: CONFIG.DURATION_MIN,
      settings: { waiting_room: true, join_before_host: false, auto_recording: 'none' }
    }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (!data.join_url) throw new Error('Zoom発行に失敗: ' + res.getContentText());
  return data;
}

// ============================================================
// カレンダー
// ============================================================
function getCalendar_() {
  const cal = (CONFIG.CALENDAR_ID === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) throw new Error('カレンダーが見つかりません: ' + CONFIG.CALENDAR_ID);
  return cal;
}

function createHoldEvent_(id, name, email, startAt, endAt, answers, deadline) {
  const ev = getCalendar_().createEvent(
    '【仮】' + CONFIG.TITLE + '／' + name + '様',
    startAt, endAt,
    { description: eventBody_(id, name, email, answers,
        '⚠ 入金待ち（期限 ' + fmtDateTime_(deadline) + '）', '') }
  );
  return ev.getId();
}

function eventBody_(id, name, email, answers, payLine, zoomUrl) {
  const lines = [
    '■ ' + CONFIG.TITLE,
    'お名前: ' + name,
    'メール: ' + email,
    'お支払い: ' + payLine,
    zoomUrl ? ('Zoom: ' + zoomUrl) : '',
    '受付番号: ' + id,
    ''
  ];
  QUESTIONS.forEach(function (q) {
    lines.push(q.label + ': ' + (prettyAnswer_(q, answers) || '—'));
  });
  return lines.filter(function (v) { return v !== ''; }).join('\n');
}

// ============================================================
// スプレッドシート
// ============================================================
function getSheet_() {
  let id = PROPS.getProperty('SHEET_ID');
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('エニアグラムセッション 予約ログ');
    PROPS.setProperty('SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setColumnWidth(HEADERS.indexOf('回答') + 1, 320);
  }
  return sh;
}

/** 1行を読み書きするためのラッパー */
function rowApi_(sh, rowNo, values) {
  return {
    rowNo: rowNo,
    get: function (h) { return values[HEADERS.indexOf(h)]; },
    set: function (h, v) {
      values[HEADERS.indexOf(h)] = v;
      sh.getRange(rowNo, HEADERS.indexOf(h) + 1).setValue(v);
    }
  };
}

function eachRow_(fn) {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    try { fn(rowApi_(sh, i + 1, values[i])); }
    catch (err) { logError_('eachRow', err, { row: i + 1 }); }
  }
}

function findByToken_(token) {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  const c = HEADERS.indexOf('確定トークン');
  for (let i = 1; i < values.length; i++) {
    if (values[i][c] && String(values[i][c]) === String(token)) return rowApi_(sh, i + 1, values[i]);
  }
  return null;
}

function appendLog_(d) {
  const sh = getSheet_();
  const row = [];
  row[HEADERS.indexOf('受付日時')] = new Date();
  row[HEADERS.indexOf('予約ID')] = d.id;
  row[HEADERS.indexOf('お名前')] = d.name;
  row[HEADERS.indexOf('メール')] = d.email;
  row[HEADERS.indexOf('日時')] = d.startAt;
  row[HEADERS.indexOf('終了')] = d.endAt;
  row[HEADERS.indexOf('金額')] = CONFIG.PRICE;
  row[HEADERS.indexOf('入金確認')] = false;
  row[HEADERS.indexOf('ステータス')] = ST.UNPAID;
  row[HEADERS.indexOf('支払期限')] = d.deadline;
  row[HEADERS.indexOf('ZoomURL')] = '';
  row[HEADERS.indexOf('カレンダーID')] = d.eventId;
  row[HEADERS.indexOf('催促送信')] = '';
  row[HEADERS.indexOf('リマインド送信')] = '';
  row[HEADERS.indexOf('回答')] = JSON.stringify(d.answers);
  row[HEADERS.indexOf('流入経路')] = d.from || '';
  row[HEADERS.indexOf('確定トークン')] = d.token;
  sh.appendRow(row);
  // 「入金確認」列をチェックボックスにする（メールのリンクを使わず、ここで確定してもOK）
  sh.getRange(sh.getLastRow(), HEADERS.indexOf('入金確認') + 1).insertCheckboxes();
  return sh.getLastRow();
}

/** スプレッドシートの「入金確認」チェックボックスをONにしたときに確定する */
function onSheetEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== SHEET_NAME) return;
    if (e.range.getColumn() !== HEADERS.indexOf('入金確認') + 1) return;
    if (e.range.getRow() < 2) return;
    if (e.value !== 'TRUE') return;

    const values = sh.getRange(e.range.getRow(), 1, 1, HEADERS.length).getValues()[0];
    const r = rowApi_(sh, e.range.getRow(), values);
    if (r.get('ステータス') !== ST.UNPAID) return;
    confirmBooking_(r);
    if (e.source) e.source.toast(r.get('お名前') + '様の予約を確定し、確定メールを送りました。');
  } catch (err) {
    logError_('onSheetEdit', err, {});
  }
}

// ============================================================
// 小道具
// ============================================================
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function html_(h) { return h; }

function page_(title, body) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:-apple-system,\'Hiragino Sans\',sans-serif;background:#FDF8F2;' +
    'color:#2D2D2D;padding:40px 24px;line-height:1.9;max-width:520px;margin:0 auto">' +
    '<h1 style="font-size:20px;color:#C96A45">' + title + '</h1><p>' + body + '</p></div>'
  ).setTitle(title);
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function webAppUrl_() {
  return PROPS.getProperty('WEBAPP_URL') || '';
}

function safeParse_(s) {
  try { return JSON.parse(s) || {}; } catch (e) { return {}; }
}

function atTime_(day, hhmm) {
  const p = hhmm.split(':');
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(p[0]), Number(p[1]), 0, 0);
}

function fmtDateTime_(d) {
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Utilities.formatDate(d, CONFIG.TZ, 'yyyy年M月d日') + '(' + w + ') ' +
         Utilities.formatDate(d, CONFIG.TZ, 'HH:mm');
}

function fmtDateShort_(d) {
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Utilities.formatDate(d, CONFIG.TZ, 'M/d') + '(' + w + ') ' +
         Utilities.formatDate(d, CONFIG.TZ, 'HH:mm');
}

function yen_(n) { return Number(n).toLocaleString('ja-JP') + '円'; }

function logError_(where, err, ctx) {
  console.error(where, err, ctx);
  notifyDiscord_({
    title: '⚠️ 予約システムでエラー',
    color: 0xC0392B,
    fields: [fld_('場所', where, true), fld_('内容', String(err && err.message || err), false)]
  });
  try {
    MailApp.sendEmail({
      to: CONFIG.ADMIN_EMAIL,
      subject: '[要確認] 予約システムでエラー（' + where + '）',
      body: ['場所: ' + where, 'エラー: ' + (err && err.message || err), '',
             JSON.stringify(ctx, null, 2)].join('\n')
    });
  } catch (e2) {}
}

// ============================================================
// セットアップ用（GASエディタから手で実行する）
// ============================================================

/** 1) Zoomの認証情報を登録する。値を書き換えてから実行 → 実行後は 'ここに〜' に戻すこと */
function setUpSecrets() {
  PROPS.setProperties({
    ZOOM_ACCOUNT_ID: 'ここにZoomのAccount ID',
    ZOOM_CLIENT_ID: 'ここにZoomのClient ID',
    ZOOM_CLIENT_SECRET: 'ここにZoomのClient Secret',
    DISCORD_WEBHOOK_URL: 'ここにDiscordのウェブフックURL'  // 使わないなら空文字 '' でOK
  });
  console.log('保存しました');
}

/** 2) デプロイして出てきたウェブアプリURLを登録する（通知メールの確定リンクに使います） */
function setUpWebAppUrl() {
  const url = 'ここにデプロイして出てきた /exec で終わるURL';
  PROPS.setProperty('WEBAPP_URL', url);
  console.log('保存しました: ' + url);
}

/** 3) 毎日の自動処理（催促・期限切れ・リマインド）と、スプシのチェックボックス連動を設定する */
function setUpTrigger() {
  const ss = getSheet_().getParent();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'dailyJob' || f === 'onSheetEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().atHour(9).everyDays(1).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  console.log('設定しました。毎朝9時台に自動処理が走ります。');
  console.log('予約ログ: ' + ss.getUrl());
}

/** 4) 動作確認用 */
function testSetup() {
  const slots = listOpenSlots_();
  console.log('空き枠の数: ' + slots.length);
  console.log('最初の5件: ' + slots.slice(0, 5).map(function (s) { return s.label; }).join(' / '));
  console.log('予約ログ: ' + getSheet_().getParent().getUrl());
  console.log('ウェブアプリURL: ' + (webAppUrl_() || '⚠ 未登録（setUpWebAppUrl を実行してください）'));
  console.log('PayPal URL: ' + CONFIG.PAYPAL_URL);
  console.log('Discord通知: ' + (PROPS.getProperty('DISCORD_WEBHOOK_URL') ? 'ON' : 'OFF（未登録）'));
}

/** 5) Discord通知だけを単体で確認する（チャンネルにテスト投稿が1件入ります） */
function testDiscord() {
  if (!PROPS.getProperty('DISCORD_WEBHOOK_URL')) {
    console.log('⚠ DISCORD_WEBHOOK_URL が未登録です');
    return;
  }
  discordNew_('TESTTOKEN', 'テスト 太郎', 'test@example.com',
    new Date(Date.now() + 3 * 24 * 3600 * 1000),
    { topic: 'これはテスト投稿です' },
    new Date(Date.now() + 24 * 3600 * 1000));
  console.log('送信しました。Discordを見てください（確定リンクは押さないでね）');
}

/** 6) Zoom連携だけを単体で確認する（テスト用ミーティングが1件できます） */
function testZoom() {
  const m = zoomCreateMeeting_('テスト', new Date(Date.now() + 3 * 24 * 3600 * 1000));
  console.log('OK: ' + m.join_url);
}
