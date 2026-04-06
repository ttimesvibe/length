import { useState, useCallback } from "react";
import JSZip from "jszip";

// ═══════════════════════════════════════════
// DOCX PARSER — Track Changes (w:del, w:strike)
// ═══════════════════════════════════════════

async function parseDocxWithTrackChanges(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("word/document.xml을 찾을 수 없습니다");
  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error("문서 본문을 찾을 수 없습니다");
  const bodyXml = bodyMatch[1];
  const paragraphs = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyXml)) !== null) {
    const pXml = pMatch[0];
    const segments = [];
    const tokenRegex = /<w:del\b[^>]*>([\s\S]*?)<\/w:del>|<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>|<w:r[ >]([\s\S]*?)<\/w:r>/g;
    let tMatch;
    while ((tMatch = tokenRegex.exec(pXml)) !== null) {
      if (tMatch[1] !== undefined) {
        const delText = extractTextFromRuns(tMatch[1]);
        if (delText) segments.push({ text: delText, deleted: true });
      } else if (tMatch[2] !== undefined) {
        const insText = extractTextFromRuns(tMatch[2]);
        if (insText) segments.push({ text: insText, deleted: false });
      } else if (tMatch[3] !== undefined) {
        const runContent = tMatch[3];
        const runText = extractTextFromRun(runContent);
        const isStrike = /<w:strike\/>/.test(runContent);
        if (runText) segments.push({ text: runText, deleted: isStrike });
      }
    }
    if (segments.length > 0) paragraphs.push(segments);
  }
  const hasTrackChanges = paragraphs.some(p => p.some(s => s.deleted));
  const fullText = paragraphs.map(p => p.map(s => s.text).join("")).join("\n");
  const cleanText = paragraphs.map(p => p.filter(s => !s.deleted).map(s => s.text).join("")).join("\n");
  return { paragraphs, hasTrackChanges, fullText, cleanText };
}

function extractTextFromRuns(xml) {
  const texts = [];
  const rRegex = /<w:r[ >][\s\S]*?<\/w:r>/g;
  let m;
  while ((m = rRegex.exec(xml)) !== null) {
    const t = extractTextFromRun(m[0]);
    if (t !== "") texts.push(t);
  }
  return texts.join("");
}

function extractTextFromRun(runXml) {
  const texts = [];
  const tokenRegex = /<w:(?:t|delText)[^>]*>([\s\S]*?)<\/w:(?:t|delText)>|<w:br\/>/g;
  let m;
  while ((m = tokenRegex.exec(runXml)) !== null) {
    if (m[1] !== undefined) texts.push(m[1]);
    else texts.push("\n");
  }
  return texts.join("");
}

// ═══════════════════════════════════════════
// BLOCK PARSER & DURATION CALCULATOR
// ═══════════════════════════════════════════

function parseBlocks(text) {
  const lines = text.split("\n"), blocks = [];
  let cur = null;
  const hdr = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  const hdrInline = /^([가-힣a-zA-Z\s]{2,15}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.+)$/;
  const hdrNumbered = /^((?:참석자|화자|Speaker)\s*\d+)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur) { blocks.push(cur); cur = null; } continue; }
    const m3 = t.match(hdrNumbered);
    if (m3) {
      if (cur) blocks.push(cur);
      const bodyText = (m3[3] || "").trim();
      cur = { index: blocks.length, speaker: m3[1].trim(), timestamp: m3[2], text: bodyText, lines: bodyText ? [bodyText] : [] };
      continue;
    }
    const m = t.match(hdr);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { index: blocks.length, speaker: m[1], timestamp: m[2], text: "", lines: [] };
    } else {
      const m2 = t.match(hdrInline);
      if (m2) {
        if (cur) blocks.push(cur);
        const bodyText = m2[3].trim();
        cur = { index: blocks.length, speaker: m2[1].trim(), timestamp: m2[2], text: bodyText, lines: [bodyText] };
      } else if (cur) {
        cur.text += (cur.text ? "\n" : "") + t; cur.lines.push(t);
      } else {
        cur = { index: blocks.length, speaker: "—", timestamp: "", text: t, lines: [t] };
      }
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b, i) => ({ ...b, index: i }));
}

const TRAINING_DATA = [
  { name: "최지웅2편", chars: 17851, minutes: 32 },
  { name: "박종천1편", chars: 15602, minutes: 25 },
  { name: "강정수1편", chars: 14470, minutes: 27.35 },
  { name: "강수진4편", chars: 13520, minutes: 27.87 },
  { name: "김창현1편", chars: 26505, minutes: 49.83 },
  { name: "김창현2편", chars: 14820, minutes: 28.05 },
  { name: "이세돌1편", chars: 17808, minutes: 34.2 },
  { name: "이세돌2편", chars: 21019, minutes: 32.8 },
];

const HYBRID_ALPHA = 0.6; // 글로벌 비중 60% + 로컬 40% (MAE 4.5%)

function calcLearningStats() {
  if (TRAINING_DATA.length === 0) return { avgCharsPerMin: 540, count: 0, stdCharsPerMin: 0 };
  const rates = TRAINING_DATA.map(d => d.chars / d.minutes);
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + (r - avg) ** 2, 0) / rates.length;
  const std = Math.sqrt(variance);
  return { avgCharsPerMin: Math.round(avg * 10) / 10, stdCharsPerMin: Math.round(std * 10) / 10, count: TRAINING_DATA.length };
}

function calc95CI(chars, learning, totalChars, totalSeconds) {
  if (!learning.count || !learning.avgCharsPerMin) return null;
  const globalRate = learning.avgCharsPerMin;
  let effectiveRate = globalRate;
  let method = "글자수";
  if (totalSeconds > 0 && totalChars > 0) {
    const localRate = (totalChars / totalSeconds) * 60;
    effectiveRate = globalRate * HYBRID_ALPHA + localRate * (1 - HYBRID_ALPHA);
    method = "TS+밀도";
  }
  const pointSec = (chars / effectiveRate) * 60;
  const lowRate = effectiveRate + 1.96 * learning.stdCharsPerMin;
  const highRate = effectiveRate - 1.96 * learning.stdCharsPerMin;
  if (highRate <= 0) return { pointSec, lowSec: pointSec * 0.8, highSec: pointSec * 1.2, method, effectiveRate: Math.round(effectiveRate * 10) / 10 };
  const lowSec = (chars / lowRate) * 60;
  const highSec = (chars / highRate) * 60;
  return { pointSec, lowSec, highSec, method, effectiveRate: Math.round(effectiveRate * 10) / 10 };
}

function tsToSeconds(ts) {
  if (!ts) return 0;
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function secondsToDisplay(sec) {
  sec = Math.round(sec);
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function calcDuration(blocks, deletedBlockIndices = new Set()) {
  const learning = calcLearningStats();
  let totalSeconds = 0, deletedSeconds = 0, keptSeconds = 0;
  let keptChars = 0, totalChars = 0, deletedChars = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], nextB = blocks[i + 1];
    const startSec = tsToSeconds(b.timestamp);
    const endSec = nextB ? tsToSeconds(nextB.timestamp) : (startSec + 10);
    const duration = Math.max(0, endSec - startSec);
    const isDeleted = deletedBlockIndices.has(i);
    totalSeconds += duration; totalChars += b.text.length;
    if (isDeleted) { deletedSeconds += duration; deletedChars += b.text.length; }
    else { keptSeconds += duration; keptChars += b.text.length; }
  }
  const learningEstimateSec = learning.count > 0 ? (keptChars / learning.avgCharsPerMin) * 60 : null;
  return { totalSeconds, deletedSeconds, keptSeconds, totalChars, deletedChars, keptChars, learningEstimateSec, learning };
}

// ═══════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════

const C = {
  bg:"#F5F6FA", sf:"#FFFFFF", bd:"#D8DBE5",
  tx:"#1A1D2E", txM:"#5C6078", txD:"#8B8FA3",
  ac:"#5B4CD4", acS:"rgba(91,76,212,0.08)",
  tBg:"rgba(220,38,38,0.08)", tTx:"#DC2626", tBorder:"rgba(220,38,38,0.15)",
  cBg:"rgba(22,163,74,0.08)", cTx:"#16A34A", cBorder:"rgba(22,163,74,0.15)", cMid:"rgba(22,163,74,0.06)",
  ok:"#16A34A", wn:"#D97706",
  inputBg:"rgba(0,0,0,0.03)",
  btnTx:"#fff",
  delBg:"rgba(220,38,38,0.08)",
  glass:"rgba(0,0,0,0.02)", glass2:"rgba(0,0,0,0.04)",
  gradAc:"linear-gradient(135deg,#5B4CD4,#7C3AED)",
  acFade:"rgba(91,76,212,0.2)",
};
const FN = "'Pretendard Variable','Pretendard','Noto Sans KR',-apple-system,sans-serif";

// ═══════════════════════════════════════════
// APP
// ═══════════════════════════════════════════

export default function App() {
  const [fn, setFn] = useState("");
  const [result, setResult] = useState(null); // { paragraphs, duration, blocks, deletedBlockIndices, cleanTextChars, hasTrackChanges }
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    setErr(null); setResult(null); setLoading(true); setFn(file.name);
    try {
      let text, paragraphs, hasTrackChanges = false, cleanText;

      if (file.name.endsWith(".docx")) {
        const buf = await file.arrayBuffer();
        const tcResult = await parseDocxWithTrackChanges(buf);
        text = tcResult.fullText;
        cleanText = tcResult.cleanText;
        paragraphs = tcResult.paragraphs;
        hasTrackChanges = tcResult.hasTrackChanges;
      } else {
        text = await file.text();
        cleanText = text;
        paragraphs = null;
      }

      const blocks = parseBlocks(text);
      if (blocks.length === 0) throw new Error("블록을 파싱할 수 없습니다. 화자+타임스탬프 형식의 원고를 업로드하세요.");

      // 삭제선 있으면 삭제 블록 판정
      const deletedBlockIndices = new Set();
      if (hasTrackChanges && paragraphs) {
        const charMap = [];
        for (let pi = 0; pi < paragraphs.length; pi++) {
          for (const seg of paragraphs[pi]) {
            for (let ci = 0; ci < seg.text.length; ci++) charMap.push(seg.deleted);
          }
          if (pi < paragraphs.length - 1) charMap.push(false);
        }
        const fullText = text;
        let searchFrom = 0;
        for (const rb of blocks) {
          const blockStart = fullText.indexOf(rb.text, searchFrom);
          if (blockStart === -1) continue;
          searchFrom = blockStart + rb.text.length;
          let deletedCount = 0;
          for (let ci = 0; ci < rb.text.length; ci++) {
            if ((blockStart + ci) < charMap.length && charMap[blockStart + ci]) deletedCount++;
          }
          const textLen = rb.text.replace(/\s/g, "").length;
          if (textLen > 0 && deletedCount >= textLen * 0.8) deletedBlockIndices.add(rb.index);
        }
      }

      const duration = calcDuration(blocks, deletedBlockIndices);
      const cleanTextChars = cleanText.replace(/\s/g, "").length;

      setResult({ paragraphs, duration, blocks, deletedBlockIndices: [...deletedBlockIndices], cleanTextChars, hasTrackChanges });
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const onFileChange = useCallback((e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleReset = () => { setFn(""); setResult(null); setErr(null); };

  return <div style={{fontFamily:FN, background:C.bg, minHeight:"100vh", color:C.tx}}>
    {/* Header */}
    <div style={{background:C.sf, borderBottom:`1px solid ${C.bd}`, padding:"14px 20px",
      display:"flex", alignItems:"center", gap:12}}>
      <div style={{fontSize:16, fontWeight:800, color:C.ac}}>🎬 영상 길이 예측기</div>
      {fn && <span style={{fontSize:12, color:C.txM, background:C.glass2, padding:"3px 10px", borderRadius:6}}>{fn}</span>}
      {result && <button onClick={handleReset} style={{marginLeft:"auto", fontSize:12, padding:"5px 14px",
        borderRadius:6, border:`1px solid ${C.bd}`, background:C.sf, color:C.txM, cursor:"pointer"}}>× 새 파일</button>}
    </div>

    {/* Upload Area */}
    {!result && !loading && <div style={{maxWidth:560, margin:"80px auto", padding:"0 24px"}}>
      <div style={{textAlign:"center", marginBottom:32}}>
        <div style={{fontSize:48, marginBottom:16}}>🎬</div>
        <h1 style={{fontSize:24, fontWeight:700, marginBottom:8}}>영상 길이 예측기</h1>
        <p style={{fontSize:14, color:C.txM, lineHeight:1.7}}>
          인터뷰 원고(docx/txt)를 업로드하면<br/>
          타임스탬프 + 학습 데이터 기반으로 영상 길이를 예측합니다.
        </p>
        <p style={{fontSize:12, color:C.txD, marginTop:8}}>
          Word 검토 모드(취소선/삭제선)가 있으면 삭제 구간을 자동 감지합니다.
        </p>
      </div>

      <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={onDrop}
        style={{border:`2px dashed ${dragOver?C.ac:C.bd}`, borderRadius:16, padding:"48px 32px",
          textAlign:"center", background:dragOver?C.acS:C.sf, transition:"all 0.15s", cursor:"pointer"}}
        onClick={()=>document.getElementById("fileInput").click()}>
        <div style={{fontSize:32, marginBottom:12, opacity:0.5}}>{dragOver?"📂":"📄"}</div>
        <div style={{fontSize:14, fontWeight:600, color:C.tx, marginBottom:6}}>
          파일을 드래그하거나 클릭하여 업로드
        </div>
        <div style={{fontSize:12, color:C.txD}}>.docx 또는 .txt</div>
        <input id="fileInput" type="file" accept=".docx,.txt" onChange={onFileChange} style={{display:"none"}}/>
      </div>

      {err && <div style={{marginTop:16, padding:"12px 16px", borderRadius:10,
        background:C.tBg, border:`1px solid ${C.tBorder}`, color:C.tTx, fontSize:13}}>
        ⚠️ {err}
      </div>}
    </div>}

    {/* Loading */}
    {loading && <div style={{textAlign:"center", padding:"120px 24px"}}>
      <div style={{fontSize:40, marginBottom:16, animation:"spin 1.5s linear infinite"}}>⏳</div>
      <div style={{fontSize:14, color:C.txM}}>원고 분석 중...</div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>}

    {/* Result */}
    {result && (() => {
      const { duration, blocks, deletedBlockIndices, cleanTextChars, hasTrackChanges, paragraphs } = result;
      const delSet = new Set(deletedBlockIndices || []);
      const learning = calcLearningStats();
      const cleanChars = cleanTextChars || duration.keptChars;
      const ci = calc95CI(cleanChars, learning, duration.totalChars, duration.totalSeconds);

      return <div style={{display:"flex", flexDirection:"column", height:"calc(100vh - 52px)"}}>
        {/* Summary Cards */}
        <div style={{padding:"20px 24px", background:C.sf, borderBottom:`1px solid ${C.bd}`, flexShrink:0}}>
          <div style={{display:"flex", gap:14, flexWrap:"wrap", maxWidth:900, margin:"0 auto"}}>
            {/* 원본 분량 */}
            <div style={{flex:1, minWidth:200, padding:16, borderRadius:12, background:C.glass, border:`1px solid ${C.bd}`}}>
              <div style={{fontSize:11, fontWeight:700, color:C.txD, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10}}>📄 원본 분량</div>
              <div style={{fontSize:28, fontWeight:800, color:C.tx, marginBottom:4}}>{secondsToDisplay(duration.totalSeconds)}</div>
              <div style={{fontSize:12, color:C.txM}}>{duration.totalChars.toLocaleString()}자 · {blocks.length}블록</div>
            </div>
            {/* 예상 영상 길이 */}
            <div style={{flex:1, minWidth:200, padding:16, borderRadius:12, background:C.cBg, border:`1px solid ${C.cBorder}`}}>
              <div style={{fontSize:11, fontWeight:700, color:C.cTx, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10}}>🎬 예상 영상 길이</div>
              {ci ? <>
                <div style={{display:"flex", alignItems:"baseline", gap:8}}>
                  <div style={{fontSize:28, fontWeight:800, color:C.cTx}}>{secondsToDisplay(ci.pointSec)}</div>
                  {ci.method === "TS+밀도" && <span style={{fontSize:10, padding:"2px 6px", borderRadius:4, background:C.cMid, color:C.txD}}>TS+밀도</span>}
                </div>
                <div style={{marginTop:6, padding:"5px 10px", borderRadius:6, background:C.cMid, display:"inline-block"}}>
                  <span style={{fontSize:12, color:C.txM, fontWeight:600}}>
                    {secondsToDisplay(ci.lowSec)} ~ {secondsToDisplay(ci.highSec)}
                  </span>
                  <span style={{fontSize:10, color:C.txD, marginLeft:6}}>(95% 신뢰구간)</span>
                </div>
                <div style={{marginTop:6, fontSize:10, color:C.txD}}>
                  {learning.count}건 학습 · 적용 {ci.effectiveRate}자/분 · 삭제 후 {cleanChars.toLocaleString()}자
                </div>
                {duration.keptSeconds > 0 && <div style={{fontSize:11, color:C.txD, marginTop:4}}>
                  타임스탬프 기준: {secondsToDisplay(duration.keptSeconds)}
                </div>}
              </> : <>
                <div style={{fontSize:28, fontWeight:800, color:C.cTx}}>{secondsToDisplay(duration.keptSeconds)}</div>
                <span style={{fontSize:11, color:C.txD}}>(타임스탬프 기준)</span>
              </>}
              <div style={{fontSize:12, color:C.txM, marginTop:4}}>{blocks.length - delSet.size}블록 잔존</div>
            </div>
          </div>

          {/* 학습 데이터 표 */}
          <details style={{maxWidth:900, margin:"14px auto 0"}}>
            <summary style={{fontSize:12, color:C.txD, cursor:"pointer", userSelect:"none"}}>📊 학습 데이터 ({TRAINING_DATA.length}건)</summary>
            <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))", gap:6, marginTop:8}}>
              {TRAINING_DATA.map((d,i) => <div key={i} style={{fontSize:11, color:C.txM, padding:"4px 8px", borderRadius:6, background:C.glass, border:`1px solid ${C.bd}`}}>
                {d.name} — {d.chars.toLocaleString()}자 / {d.minutes}분 ({Math.round(d.chars/d.minutes)}자/분)
              </div>)}
            </div>
          </details>
        </div>

        {/* 원고 미리보기 */}
        <div style={{flex:1, overflowY:"auto"}}>
          <div style={{padding:"8px 16px", fontSize:11, fontWeight:700, color:C.txD, textTransform:"uppercase",
            letterSpacing:"0.08em", borderBottom:`1px solid ${C.bd}`, position:"sticky", top:0, background:C.bg, zIndex:2}}>
            원고 {hasTrackChanges ? "— 취소선은 빨간색으로 표시됩니다" : "미리보기"}
          </div>
          <div style={{padding:"16px 20px", maxWidth:900, margin:"0 auto"}}>
            {hasTrackChanges && paragraphs ? (
              paragraphs.map((p, pi) => {
                const paraText = p.map(s => s.text).join("");
                if (!paraText.trim()) return <div key={pi} style={{height:12}}/>;
                return <p key={pi} style={{fontSize:14, lineHeight:1.9, color:C.tx,
                  marginBottom:4, wordBreak:"keep-all", whiteSpace:"pre-wrap"}}>
                  {p.map((seg, si) => seg.deleted
                    ? <span key={si} style={{textDecoration:"line-through", textDecorationColor:C.tTx,
                        background:C.delBg, color:C.tTx, padding:"1px 2px", borderRadius:3}}>{seg.text}</span>
                    : <span key={si}>{seg.text}</span>
                  )}
                </p>;
              })
            ) : (
              blocks.map((b, i) => <div key={i} style={{padding:"6px 0", borderBottom:`1px solid ${C.bd}22`}}>
                <div style={{display:"flex", gap:6, alignItems:"center", marginBottom:2}}>
                  <span style={{fontSize:10, fontWeight:700, color:C.txD, fontFamily:"monospace",
                    background:C.glass2, padding:"1px 5px", borderRadius:3}}>#{i}</span>
                  <span style={{fontSize:11, fontWeight:600, color:C.ac}}>{b.speaker}</span>
                  <span style={{fontSize:11, color:C.txD, fontFamily:"monospace"}}>{b.timestamp}</span>
                </div>
                <div style={{fontSize:14, lineHeight:1.8, color:C.tx, whiteSpace:"pre-wrap"}}>{b.text}</div>
              </div>)
            )}
          </div>
        </div>
      </div>;
    })()}
  </div>;
}
