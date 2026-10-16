// KEEPERS for Pixels — AI 판독 서버 기능 (Vercel)
// 브라우저가 보낸 이미지 한 장을 Google Gemini에 보내, AI 이미지가 자주 틀리는 부분(손가락, 얼굴, 몸, 글자, 사물, 배경, 주제)을 판독하고 문제 위치까지 돌려준다.
// API 키는 Vercel 환경 변수 GEMINI_API_KEY에만 둔다. 코드, GitHub, 브라우저 어디에도 키가 나오지 않는다.

// 정확도를 위해 flash를 먼저 쓰고, 사용량이 차면(429) 가벼운 flash-lite로 넘어간다
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest'].filter(Boolean))];
const DAY_LIMIT = Number(process.env.DAILY_LIMIT || 200);    // 사이트 전체 하루 판독 수
const IP_LIMIT = Number(process.env.IP_DAILY_LIMIT || 40);   // 한 사람(접속 주소)당 하루 판독 수
const ORIGIN_OK = /^https:\/\/keepers-for-pixels[a-z0-9-]*\.vercel\.app$/; // 우리 사이트에서 온 요청만 받는다
const MIMES = ['image/jpeg', 'image/png', 'image/webp'];

// 하루 사용량 세기 (서버가 잠들면 초기화되는 간단한 방식. 실제 요금 방어는 Google 무료 단계 + 결제 미등록으로 한다)
let day = '', total = 0;
const perIp = new Map();

const PROMPT = topic => "너는 AI 생성 이미지의 결함을 찾는 신중한 검수 전문가야. 없는 문제를 지어내는 것은 문제를 놓치는 것보다 더 나쁜 실수야.\n먼저 scene에 장면을 한두 문장으로 적어: 누가 있는지, 각 인물이 어디를 보며 무엇을 하는지, 화면·책·거울이 어느 쪽을 향하는지.\n그다음 아래 8가지를 하나씩 확인해.\n1. hand: 손가락이 5개가 아님(6개, 4개), 손가락이 붙거나 녹아듦, 관절이 반대로 꺾임, 손이 너무 많음, 손목이 팔과 맞지 않게 돌아감, 손바닥·손등 방향이 팔의 방향과 뒤바뀜(손이 거꾸로 붙은 것처럼 보임). 사람마다 두 손을 각각 팔에서 손끝까지 따라가며 확인해. 손 모양이 분명히 보이는 손만 판단하고, 가려지거나 흐려서 알아볼 수 없는 손, 화풍 때문에 단순하게 그린 손은 넣지 마.\n2. face: 두 눈의 크기·방향이 다름, 이상한 치아·귀·눈동자, 녹아내리거나 뭉개진 얼굴, 군중 속에 똑같이 복제된 얼굴\n3. body: 팔다리 개수·길이 이상, 몸이 사물이나 다른 사람과 합쳐짐, 불가능한 자세, 동물의 다리·꼬리 개수 이상\n4. text: 철자가 깨진 글자, 읽을 수 없는 글자 모양, 엉터리 간판·로고, 시계 숫자판·키보드 자판·피아노 건반의 배열 이상\n5. object: 사물끼리 녹아 붙음, 끊기거나 엉뚱하게 이어지는 선(난간·전선·줄·끈·기타 줄), 짝이 안 맞는 안경·귀걸이·신발, 물리적으로 불가능한 구조\n6. background: 휘어진 직선, 어긋난 원근, 그림자·반사 방향이 맞지 않음, 머리카락·옷이 배경에 녹아드는 경계\n7. logic: 장면의 앞뒤가 안 맞음 - 인물이 보는 화면·책이 인물 반대쪽을 향함, 거울 속 모습이 실제와 다름, 시선과 행동이 맞지 않음, 물건을 불가능한 방식으로 쥠, 받침 없이 떠 있는 물건\n8. topic: TOPIC_RULE\nPROMPT_RULE\n규칙:\n- 각 문제마다 confidence를 적어. high=이미지에서 분명히 보이고 누가 봐도 틀림, medium=그럴 수도 있음, low=애매함.\n- 의도된 화풍(만화·일러스트의 과장, 단순화)은 결함이 아니야. 같은 문제는 한 번만 넣어.\n- 각 문제의 위치를 box_2d [ymin, xmin, ymax, xmax] (0~1000 기준)로 표시해. 문제가 없으면 issues는 빈 배열이야.\n아래 JSON 하나로만 답해:\n{\"scene\":\"장면 설명\",\"verdict\":\"keep|fix|redo\",\"issues\":[{\"type\":\"hand|face|body|text|object|background|logic|topic\",\"label\":\"한국어 15자 이내 설명\",\"confidence\":\"high|medium|low\",\"box_2d\":[0,0,0,0]}],\"note\":\"한국어 한 문장 요약\"}\nverdict는 confidence가 high인 문제만 보고 정해: keep=그대로 써도 됨, fix=자르기·편집으로 가릴 수 있는 작은 문제, redo=다시 만드는 편이 나음".replace('TOPIC_RULE', topic ? '사용자가 적은 주제·프롬프트와 이미지 내용이 확실히 다름' : '주제가 없으니 검사하지 않음')
  .replace('PROMPT_RULE', topic ? `사용자가 이 이미지를 만들 때 적은 주제·프롬프트: "${topic}"\n이 글은 만든 사람의 의도(어떤 장면인지, 일부러 과장한 표현인지, 빠진 요소가 있는지)를 파악하는 데만 써. 손·얼굴·몸 같은 형태 결함은 이 글에 끌려가지 말고 이미지만 보고 판단해.` : '');

const pick = (v, list, d) => (list.includes(v) ? v : d);
const TYPES = ['hand', 'face', 'body', 'text', 'object', 'background', 'logic', 'topic'];
// 모델 답을 정해진 모양으로만 다듬어 돌려준다 (잘못된 값은 버림)
// 오탐을 줄이려고 확신도(confidence)가 high인 문제만 남기고, 판정도 남은 문제 기준으로 맞춘다
function clean(a, topic) {
  a = a || {};
  const issues = (Array.isArray(a.issues) ? a.issues : [])
    .filter(x => x && (x.confidence === undefined || x.confidence === 'high'))
    .map(x => {
      const box = Array.isArray(x.box_2d) && x.box_2d.length === 4 && x.box_2d.every(n => typeof n === 'number' && isFinite(n))
        ? x.box_2d.map(n => Math.max(0, Math.min(1000, Math.round(n)))) : null;
      return { type: pick(x.type, TYPES, ''), label: typeof x.label === 'string' ? x.label.slice(0, 30) : '', box_2d: box };
    })
    .filter(x => x.type && (x.type !== 'topic' || topic))
    .slice(0, 8);
  let verdict = pick(a.verdict, ['keep', 'fix', 'redo'], 'fix');
  if (!issues.length) verdict = 'keep'; else if (verdict === 'keep') verdict = 'fix';
  const has = t => issues.some(x => x.type === t);
  return {
    verdict,
    issues,
    scene: typeof a.scene === 'string' ? a.scene.slice(0, 160) : '',
    note: typeof a.note === 'string' ? a.note.slice(0, 80) : '',
    hand: has('hand') || has('face') || has('body') ? 'bad' : 'ok',
    text: has('text') ? 'bad' : 'ok',
    topic: has('topic') ? 'bad' : topic ? 'ok' : 'unknown',
  };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ORIGIN_OK.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!ORIGIN_OK.test(origin)) return res.status(403).json({ error: 'origin' });

  const body = req.body || {};
  // 사용자가 자기 키를 보낸 경우(브라우저에서 Google로 바로 못 갈 때의 예비 길): 그 키로 판독하고, 사이트 한도는 세지 않는다. 키는 저장하지 않는다.
  const own = typeof body.userKey === 'string' && /^[A-Za-z0-9_\-]{20,120}$/.test(body.userKey) ? body.userKey : '';
  const key = own || process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'nokey' });

  const image = typeof body.image === 'string' ? body.image : '';
  const mime = pick(body.mime, MIMES, '');
  const topic = typeof body.topic === 'string' ? body.topic.replace(/["\n\r]/g, ' ').slice(0, 1000).trim() : '';
  if (!image || !mime || image.length > 3_000_000) return res.status(400).json({ error: 'bad' });

  if (!own) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; total = 0; perIp.clear(); }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const used = perIp.get(ip) || 0;
  if (total >= DAY_LIMIT || used >= IP_LIMIT) return res.status(429).json({ error: 'limit' });
  total++; perIp.set(ip, used + 1);
  }

  // 생각 단계(thinking): 장면의 앞뒤(화면 방향 등)까지 따지도록 medium. 환경 변수 GEMINI_THINKING으로 바꿀 수 있다 (low / medium / high)
  const THINK = pick(process.env.GEMINI_THINKING, ['minimal', 'low', 'medium', 'high'], 'medium');
  const body2 = think => JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: image } }, { text: PROMPT(topic) }] }],
    generationConfig: Object.assign({ responseMimeType: 'application/json', temperature: 0.2 }, think ? { thinkingConfig: { thinkingLevel: think } } : {}),
  });
  const t0 = Date.now();
  let quota = false, busy = false;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  for (const model of MODELS) {
    let r;
    const send = think => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: body2(think),
    });
    try {
      r = await send(THINK);
      if (r.status === 400) r = await send(null); // 생각 단계 설정을 모르는 모델이면 설정 없이 다시
      if (r.status >= 500) { await wait(1500); r = await send(THINK); } // Google 서버가 잠깐 바쁘면(503 등) 한 번 더
    } catch (e) {
      return res.status(502).json({ error: 'network' });
    }
    if (r.status === 404) continue; // 이 이름의 모델이 없으면 다음 후보로
    if (r.status === 429) { quota = true; continue; } // 이 모델 사용량이 찼으면 다음(더 가벼운) 모델로
    if (r.status >= 500) { busy = true; continue; }   // 다시 해도 바쁘면 다음 모델로
    if (own && (r.status === 400 || r.status === 401 || r.status === 403)) return res.status(401).json({ error: 'key' });
    if (!r.ok) return res.status(502).json({ error: 'upstream', status: r.status });
    const j = await r.json().catch(() => ({}));
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let a = {};
    try { a = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()); } catch (e) { a = {}; }
    const result = clean(a, topic);
    return res.status(200).json({ ok: true, model, ms: Date.now() - t0, result });
  }
  if (busy) return res.status(503).json({ error: 'busy' });
  if (quota) return res.status(429).json({ error: 'quota' });
  return res.status(502).json({ error: 'nomodel' });
};
