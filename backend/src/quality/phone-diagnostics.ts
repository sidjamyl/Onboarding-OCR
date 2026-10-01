/** Development-only phone diagnostics. Telemetry is stored and broadcast by CalibrationHub. */
export function phoneDiagnosticsPage(id: string): string {
  void id;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signaux de capture</title><style>
  :root{font-family:system-ui,sans-serif;color:#eef4ef;background:#101614;color-scheme:dark}
  body{margin:0;padding:20px;max-width:760px;margin-inline:auto}h1{font-size:1.4rem;margin:0 0 8px}
  p{color:#a5b5ab;margin:0 0 16px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}
  #state{font-size:.85rem;color:#d3b377}.ok{color:#62d9a3!important}.fail{color:#ff8c80!important}
  dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:16px 0}
  dl div,li{border:1px solid #34453b;border-radius:10px;padding:10px 12px;background:#1b2620}
  dt{color:#a5b5ab;font-size:.75rem}dd{margin:4px 0 0;font-variant-numeric:tabular-nums;font-weight:650}
  ul{padding:0;list-style:none;display:grid;gap:7px}li{display:flex;justify-content:space-between;gap:12px;font-size:.88rem}
  li span:last-child{text-align:right;font-variant-numeric:tabular-nums}small{color:#a5b5ab}
  a{color:#6fe7b0}button{min-height:40px;background:#284d3b;border:0;border-radius:8px;color:white;padding:0 14px}
</style></head><body><header><h1>Signaux du téléphone</h1><span id="state">Connexion…</span></header>
<p>Mesures brutes du dernier aperçu et verdict sur la photo finale. Page locale de diagnostic.</p>
<button id="freeze" type="button">Figer</button><dl id="summary"></dl><h2>Contrôles</h2><ul id="checks"></ul>
<h2>Mesures brutes</h2><dl id="metrics"></dl><p id="last"></p>
<script>
  const stream=new EventSource(location.pathname.replace('/phone-diagnostics', '/events'));
  const state=document.getElementById('state'),summary=document.getElementById('summary');
  const checks=document.getElementById('checks'),metrics=document.getElementById('metrics');
  let frozen=false;
  document.getElementById('freeze').onclick=(event)=>{frozen=!frozen;event.currentTarget.textContent=frozen?'Reprendre':'Figer'};
  function pair(name,value){const box=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=String(value??'—');box.append(dt,dd);return box}
  function render(client,at,label){if(frozen||!client)return;state.textContent=client.passed?'Prêt':'À corriger';state.className=client.passed?'ok':'fail';
    summary.replaceChildren(pair('Décision',client.passed?'Admissible':'Reprise'),pair('Conseil',client.hint),pair('Score de tri',client.score),pair('Analyse',client.durationMs+' ms'),pair('Images stables',client.stablePasses),pair('Caméra',client.camera?client.camera.width+'×'+client.camera.height:'—'));
    checks.replaceChildren(...(client.checks??[]).map(c=>{const li=document.createElement('li'),name=document.createElement('span'),value=document.createElement('span');name.textContent=c.key;value.textContent=c.status+' · '+c.value+' / '+c.threshold;li.append(name,value);return li}));
    metrics.replaceChildren(...Object.entries(client.metrics??{}).map(([key,value])=>pair(key,value)));
    document.getElementById('last').textContent=label+' · '+at;
  }
  stream.addEventListener('sample',event=>{const sample=JSON.parse(event.data);render(sample.client,sample.at,'Aperçu')});
  stream.addEventListener('capture',event=>{const capture=JSON.parse(event.data);render(capture.client,capture.at,'Photo finale');state.textContent=capture.server.passed?'Serveur : accepté':'Serveur : rejeté';state.className=capture.server.passed?'ok':'fail'});
  stream.addEventListener('snapshot',event=>{const snapshot=JSON.parse(event.data);if(snapshot.latestSample)render(snapshot.latestSample.client,snapshot.latestSample.at,'Aperçu')});
  stream.onerror=()=>{state.textContent='Reconnexion…';state.className=''};
</script></body></html>`;
}
