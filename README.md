# KEEPERS for Pixels

AI 이미지가 자주 틀리는 곳(여섯 개 손가락, 짝짝이 눈, 깨진 글자, 녹아 붙은 사물)을 찾아내는 판독기입니다. 판독 결과를 보고 쓸 만한 한 장을 고르고(Pick), 편집해(Edit), 원하는 형식으로 내보내며(Export), 최종 1장에 든 AI 비용까지 알려 줍니다.

- 배포 주소: https://keepers-for-pixels.vercel.app
- 소스 저장소: https://github.com/S13ee/keepers-for-pixels
- 이전 프로젝트: [Keepers for AI](https://keepers-for-ai.vercel.app) — 중간 점검 1차 버전, 그대로 보존

## 흐름
1. **Upload** — 사용한 AI와 요금제를 고르고 이미지를 여러 장 올립니다. AI 이미지가 아니면 "일반 사진"으로 씁니다.
   - **AI 판독**: Google Gemini가 손가락·손, 얼굴·눈, 몸·팔다리, 글자, 사물·배경, 주제를 한 장씩 검수하고 문제 위치를 표시합니다. "내 API 키" 또는 "무료 판독"(사이트 제공, 하루 한도) 중에서 고릅니다.
2. **Pick** — 해상도 낮음, 흐림, 너무 어두움·밝음, 비슷함을 자동 점검하고 Keep / Skip을 고릅니다. 최종 1장당 비용이 실시간으로 바뀝니다.
3. **Edit** — 자르기(증명 3×4cm, 여권 3.5×4.5cm 포함), 회전·뒤집기, 밝기·대비·채도·그레인·선명도, 크기·dpi·화질, 목표 용량(예: 200KB 이하) 맞추기.
4. **Export** — JPG · PNG · WebP · GIF · TIFF · PSD · BMP · ICO · SVG · PDF로 내보내기 (AVIF는 브라우저가 지원할 때만), 전부 ZIP·한 PDF로 받기, 비용 계산 과정, 비용 줄이기, 다음 프롬프트 요청문 복사, 요약 TXT · 기록 CSV.

## 특징
- 자동 점검, 편집, 내보내기는 모두 브라우저 안에서 처리합니다. 이미지는 AI 판독을 켰을 때만 작게 줄인 사본이 Google(Gemini)로 전송되고, 탭을 닫으면 사라집니다.
- AI·요금제 선택과 이번 달 누적 기록만 브라우저(localStorage)에 저장합니다.
- 한 개의 HTML 파일로 만들었습니다. PDF·ZIP 만들기 도구(jsPDF, JSZip)는 필요할 때만 cdnjs에서 불러옵니다.

## AI 판독 서버 (api/judge.js)
- Vercel 서버 기능입니다. 무료 판독 요청을 받아 Gemini에 보내고 결과만 돌려줍니다.
- API 키는 코드에 없고, Vercel 프로젝트 설정의 환경 변수 `GEMINI_API_KEY`에만 둡니다.
- 이 사이트에서 온 요청만 받으며, 하루 한도(전체 `DAILY_LIMIT`=200, 한 사람 `IP_DAILY_LIMIT`=40)를 둡니다.
- "내 API 키"를 쓰면 키는 브라우저에서 Google로 바로 가고, 사이트 서버에 저장하지 않습니다.

## 다음 단계
- 손가락 정밀 판독(손 부분 확대 후 다시 세기)
- HEIC · PSD · PDF 올리기
