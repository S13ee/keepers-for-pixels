// KEEPERS for Pixels — AI 판독 서버 기능 (Vercel)
// 브라우저가 보낸 이미지를 Google Gemini에 보내, AI 이미지가 자주 틀리는 부분을 판독하고 문제 위치까지 돌려준다.
// 판독은 두 단계다: ① 전체 판독(mode 없음) ② 1단계에서 의심한 손·얼굴만 확대해 맞는지 확인(mode: 'zoom', 앱이 잘라 보낸 조각들)
// API 키는 Vercel 환경 변수 GEMINI_API_KEY에만 둔다. 코드, GitHub, 브라우저 어디에도 키가 나오지 않는다.

// 정확도를 위해 flash를 먼저 쓰고, 사용량이 차거나 붐비면 가벼운 flash-lite로 넘어간다. GEMINI_MODEL로 맨 앞 모델을 바꿀 수 있다(예: Pro)
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest'].filter(Boolean))];
const DAY_LIMIT = Number(process.env.DAILY_LIMIT || 200);    // 사이트 전체 하루 판독 요청 수 (이미지 한 장 = 전체 판독 1 + 확대 판독 1)
const IP_LIMIT = Number(process.env.IP_DAILY_LIMIT || 40);   // 한 사람(접속 주소)당 하루 판독 요청 수
const ORIGIN_OK = /^https:\/\/keepers-for-pixels[a-z0-9-]*\.vercel\.app$/; // 우리 사이트에서 온 요청만 받는다
const MIMES = ['image/jpeg', 'image/png', 'image/webp'];
// 생각 단계(thinking): 판독 능력을 최대로 하려고 high. 환경 변수 GEMINI_THINKING으로 바꿀 수 있다 (low / medium / high)
const pick = (v, list, d) => (list.includes(v) ? v : d);
const THINK = pick(process.env.GEMINI_THINKING, ['minimal', 'low', 'medium', 'high'], 'high');

// 하루 사용량 세기 (서버가 잠들면 초기화되는 간단한 방식. 실제 요금 방어는 Google 무료 단계 + 결제 미등록으로 한다)
let day = '', total = 0;
const perIp = new Map();

const PROMPT = topic => "너는 AI 생성 이미지의 결함을 찾는 꼼꼼한 검수 전문가야. 의심되는 곳은 빠뜨리지 말고 적되, 얼마나 확실한지는 confidence로 정직하게 표시해.\n먼저 scene에 장면을 한두 문장으로 적어: 누가 있는지, 각 인물이 어디를 보며 무엇을 하는지.\n그다음 view_check에 방향을 따져 한 문장으로 적어: 이미지 안에 화면·책·종이·거울의 앞면(내용)이 보이면, 그 앞면은 이 그림을 보는 사람 쪽을 향한 것이다. 각 인물이 그 앞면을 실제로 볼 수 있는 위치와 방향인지 판단해. 볼 수 없는데 보고 있는 것처럼 그려졌다면 logic 문제로 넣어.\n그다음 아래 8가지를 하나씩 확인해.\n1. hand: 손가락 개수(5개), 붙거나 녹아든 손가락, 반대로 꺾인 관절, 너무 많은 손, 팔과 맞지 않게 돌아간 손목, 엄지 위치가 그 팔의 손으로 불가능함\n2. face: 두 눈의 크기·방향이 다름, 이상한 치아·귀·눈동자, 녹아내리거나 뭉개진 얼굴, 군중 속에 똑같이 복제된 얼굴\n3. body: 팔다리 개수·길이 이상, 몸이 사물이나 다른 사람과 합쳐짐, 불가능한 자세, 동물의 다리·꼬리 개수 이상\n4. text: 철자가 깨진 글자, 읽을 수 없는 글자 모양, 엉터리 간판·로고, 시계 숫자판·키보드 자판·피아노 건반의 배열 이상\n5. object: 사물끼리 녹아 붙음, 끊기거나 엉뚱하게 이어지는 선(난간·전선·줄·끈·기타 줄), 짝이 안 맞는 안경·귀걸이·신발, 물리적으로 불가능한 구조\n6. background: 휘어진 직선, 어긋난 원근, 그림자·반사 방향이 맞지 않음, 머리카락·옷이 배경에 녹아드는 경계\n7. logic: 장면의 앞뒤가 안 맞음 - 인물이 보는 화면·책이 인물 반대쪽을 향함, 거울 속 모습이 실제와 다름, 시선과 행동이 맞지 않음, 물건을 불가능한 방식으로 쥠, 받침 없이 떠 있는 물건\n8. topic: TOPIC_RULE\nPROMPT_RULE\n규칙:\n- confidence: high=이미지에서 분명히 보이고 누가 봐도 틀림, medium=틀린 것 같지만 확대해 봐야 확실함, low=애매함. 의심되면 confidence를 낮춰서 적되, 눈에 보이는 근거가 없는 막연한 의심(예: 'AI 그림이니 손이 이상할 것 같다')은 적지 마.\n- 의도된 화풍(만화·일러스트의 과장, 단순화)은 결함이 아니야. 같은 문제는 한 번만 넣어.\n- 각 문제의 위치를 box_2d [ymin, xmin, ymax, xmax] (0~1000 기준)로 표시해. 문제가 없으면 issues는 빈 배열이야.\n아래 JSON 하나로만 답해:\n{\"scene\":\"장면 설명\",\"view_check\":\"방향 확인 한 문장\",\"verdict\":\"keep|fix|redo\",\"issues\":[{\"type\":\"hand|face|body|text|object|background|logic|topic\",\"label\":\"한국어 15자 이내 설명\",\"confidence\":\"high|medium|low\",\"box_2d\":[0,0,0,0]}],\"note\":\"한국어 한 문장 요약\"}\nverdict는 confidence가 high인 문제만 보고 정해: keep=그대로 써도 됨, fix=자르기·편집으로 가릴 수 있는 작은 문제, redo=다시 만드는 편이 나음".replace('TOPIC_RULE', topic ? '사용자가 적은 주제·프롬프트와 이미지 내용이 확실히 다름' : '주제가 없으니 검사하지 않음')
  .replace('PROMPT_RULE', topic ? `사용자가 이 이미지를 만들 때 적은 주제·프롬프트: "${topic}"\n이 글은 만든 사람의 의도(어떤 장면인지, 일부러 과장한 표현인지, 빠진 요소가 있는지)를 파악하는 데만 써. 손·얼굴·몸 같은 형태 결함은 이 글에 끌려가지 말고 이미지만 보고 판단해.` : '');
const ZOOM = "너는 AI 생성 이미지의 손·얼굴 결함을 확인하는 검수 전문가야. 첫 이미지는 전체 그림(위치와 팔 방향 참고용)이고, 그 뒤의 [조각 0], [조각 1]… 은 1단계 판독에서 문제가 의심된 손이나 얼굴 부분을 잘라 크게 확대한 것이야. 조각 이름 옆에 1단계에서 의심한 내용이 적혀 있어.\n각 조각에서 그 의심이 실제로 맞는지 확인해.\n- 손: 손가락 개수(5개), 붙거나 녹아든 손가락, 반대로 꺾인 관절, 팔과 맞지 않게 돌아간 손목, 엄지 위치(전체 그림에서 이 손이 어느 쪽 팔에 붙어 있는지 확인해).\n- 얼굴: 두 눈의 크기·방향, 치아·귀·눈동자, 뭉개지거나 녹아내린 얼굴.\n의도된 화풍(만화·일러스트의 단순화, 과장)은 결함이 아니야. 확대해 보니 문제가 없으면 ok를 true로 하고 issues는 비워. 문제가 맞으면 ok를 false로 하고, 확인한 내용을 confidence와 함께 적어.\nconfidence: high=분명히 틀림, medium=틀린 것 같지만 확실하지 않음, low=애매함.\n아래 JSON 하나로만 답해. 모든 조각에 대해 하나씩 답하고, box_2d는 그 조각 안에서의 위치야(0~1000 기준).\n{\"crops\":[{\"crop\":0,\"ok\":true,\"issues\":[{\"type\":\"hand|face\",\"label\":\"한국어 15자 이내 설명\",\"confidence\":\"high|medium|low\",\"box_2d\":[0,0,0,0]}]}]}";

const TYPES = ['hand', 'face', 'body', 'text', 'object', 'background', 'logic', 'topic'];
const LEVELS = ['high', 'medium', 'low'];
const box = b => (Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && isFinite(n))
  ? b.map(n => Math.max(0, Math.min(1000, Math.round(n)))) : null);
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// ① 전체 판독 답을 정해진 모양으로 다듬는다. 확신도별로 나눈다: high=issues, medium=maybe, low=weak. 판정은 high 기준
function clean(a, topic) {
  a = a || {};
  const all = (Array.isArray(a.issues) ? a.issues : []).filter(x => x && typeof x === 'object');
  const item = x => ({ type: pick(x.type, TYPES, ''), label: text(x.label, 30), box_2d: box(x.box_2d) });
  const ok = x => x.type && (x.type !== 'topic' || topic);
  const issues = all.filter(x => x.confidence === undefined || x.confidence === 'high').map(item).filter(ok).slice(0, 8);
  const maybe = all.filter(x => x.confidence === 'medium').map(item).filter(ok).slice(0, 6);
  const weak = all.filter(x => x.confidence === 'low').map(item).filter(ok).slice(0, 6);
  let verdict = pick(a.verdict, ['keep', 'fix', 'redo'], 'fix');
  if (!issues.length) verdict = 'keep'; else if (verdict === 'keep') verdict = 'fix';
  return { verdict, issues, maybe, weak, scene: text(a.scene, 200), view_check: text(a.view_check, 200), note: text(a.note, 80) };
}
// ② 확대 확인 답을 다듬는다. 조각마다 ok 여부와 문제 목록(확신도 포함, 위치는 조각 안 기준)
function cleanZoom(a, n) {
  const crops = (a && Array.isArray(a.crops) ? a.crops : []).filter(c => c && Number.isInteger(c.crop) && c.crop >= 0 && c.crop < n);
  return {
    crops: crops.slice(0, n).map(c => ({
      crop: c.crop,
      ok: c.ok === true,
      issues: (Array.isArray(c.issues) ? c.issues : []).filter(x => x && typeof x === 'object')
        .map(x => ({ type: pick(x.type, ['hand', 'face'], ''), label: text(x.label, 30), confidence: pick(x.confidence, LEVELS, 'medium'), box_2d: box(x.box_2d) }))
        .filter(x => x.type).slice(0, 4),
    })),
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

  const zoom = body.mode === 'zoom';
  const image = typeof body.image === 'string' ? body.image : '';
  const mime = pick(body.mime, MIMES, '');
  const topic = typeof body.topic === 'string' ? body.topic.replace(/["\n\r]/g, ' ').slice(0, 1000).trim() : '';
  const crops = zoom && Array.isArray(body.crops) ? body.crops.filter(c => typeof c === 'string' && c.length && c.length <= 1_500_000).slice(0, 4) : [];
  const notes = zoom && Array.isArray(body.notes) ? body.notes.map(n => (typeof n === 'string' ? n.replace(/[\n\r]/g, ' ').slice(0, 60) : '')) : [];
  if (!image || !mime || image.length > 3_000_000 || (zoom && !crops.length)) return res.status(400).json({ error: 'bad' });

  if (!own) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; total = 0; perIp.clear(); }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const used = perIp.get(ip) || 0;
    if (total >= DAY_LIMIT || used >= IP_LIMIT) return res.status(429).json({ error: 'limit' });
    total++; perIp.set(ip, used + 1);
  }

  // Google에 보낼 내용: ① 이미지 + 판독 지시문, ② 전체 그림 + [조각 n] + 확대 지시문
  const parts = zoom
    ? [{ text: '[전체 이미지 - 참고용]' }, { inline_data: { mime_type: mime, data: image } },
       ...crops.flatMap((c, i) => [{ text: `[조각 ${i}]${notes[i] ? ' 1단계 의심: ' + notes[i] : ''}` }, { inline_data: { mime_type: 'image/jpeg', data: c } }]), { text: ZOOM }]
    : [{ inline_data: { mime_type: mime, data: image } }, { text: PROMPT(topic) }];
  // temperature는 지정하지 않는다: Gemini 3 공식 문서가 기본값(1.0) 유지를 강하게 권장 (낮추면 추론이 나빠질 수 있음)
  const payload = think => JSON.stringify({
    contents: [{ parts }],
    generationConfig: Object.assign({ responseMimeType: 'application/json' }, think ? { thinkingConfig: { thinkingLevel: think } } : {}),
  });
  const t0 = Date.now();
  // Vercel 무료 요금제의 최대 실행 시간(300초)에 걸려 강제로 끊기기 전에, 280초가 되면 스스로 멈추고 알려 준다
  const DEADLINE = t0 + 280000;
  const timedOut = () => res.status(504).json({ error: 'timeout' });
  let quota = false, busy = false;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  for (const model of MODELS) {
    if (Date.now() > DEADLINE - 3000) return timedOut();
    let r;
    const send = think => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: payload(think),
      signal: AbortSignal.timeout(Math.max(1000, DEADLINE - Date.now())),
    });
    try {
      r = await send(THINK);
      if (r.status === 400) r = await send(null); // 생각 단계 설정을 모르는 모델이면 설정 없이 다시
      if (r.status >= 500) { await wait(1500); r = await send(THINK); } // Google 서버가 잠깐 바쁘면(503 등) 한 번 더
    } catch (e) {
      if (Date.now() >= DEADLINE - 1000) return timedOut();
      return res.status(502).json({ error: 'network' });
    }
    if (r.status === 404) continue; // 이 이름의 모델이 없으면 다음 후보로
    if (r.status === 429) { quota = true; continue; } // 이 모델 사용량이 찼으면 다음(더 가벼운) 모델로
    if (r.status >= 500) { busy = true; continue; }   // 다시 해도 바쁘면 다음 모델로
    if (own && (r.status === 400 || r.status === 401 || r.status === 403)) return res.status(401).json({ error: 'key' });
    if (!r.ok) return res.status(502).json({ error: 'upstream', status: r.status });
    const j = await r.json().catch(() => ({}));
    const out = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let a = {};
    try { a = JSON.parse(out.replace(/^```(json)?|```$/g, '').trim()); } catch (e) { a = {}; }
    return res.status(200).json({ ok: true, model, ms: Date.now() - t0, result: zoom ? cleanZoom(a, crops.length) : clean(a, topic) });
  }
  if (busy) return res.status(503).json({ error: 'busy' });
  if (quota) return res.status(429).json({ error: 'quota' });
  return res.status(502).json({ error: 'nomodel' });
};
