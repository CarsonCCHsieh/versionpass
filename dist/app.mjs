import { randomId, hashFile, createVersion, createApproval, verifyFile, createDemoWorkspace, MAX_FILE_BYTES } from './lib/core.mjs';
import { createTestIdentities, requestTestCredits, anchorRecord, checkRecord } from './lib/solana.mjs';
import { MAX_RECEIPT_VERSIONS, parseReceiptFile, serializeReceiptBundle, upsertObservation, verificationPlan, liveSummary, creditStatusKey } from './lib/receipt-ui.mjs';

const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const en = Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(el => [el.dataset.i18n, el.innerHTML]));
const translations = {
  en,
  'zh-TW': {
    workspace:'創作交付工作區',workspaceLabel:'工作區',deliveries:'交付版本',verifyTab:'驗證收據',localFirst:'檔案留在你手上。',privacy:'原始檔案不會離開這個瀏覽器。',allProjects:'所有 MICRO USADA 作品',projectTitle:'未命名交付',eyebrow:'好的交付，從清楚開始。',headline:'讓最終版，<br><span>真正定案。</span>',intro:'一個版本，一次明確核准，一份人人可查的收據。',tryDemo:'探索示範 ↗',newDelivery:'＋ 新增交付',deliveryDesk:'你的交付工作台',localDraft:'本機草稿',noFile:'從你的最終檔案開始',noFileMeta:'加入檔案，或探索示範交付。',deliveryDocument:'交付筆記',documentTitle:'好作品。<br>清楚交付。',documentCaption:'創作的最後一哩路。',previewCaption:'示意封面 · 原始檔案留在本機',localOnly:'僅限本機',versionHistory:'版本紀錄',versionHint:'每次修改，都有自己的指紋。',noVersions:'你的第一次交付，從這裡開始。',receiptTitle:'交付收據',receiptHeadline:'少一點「哪一版？」<br>多一點「就是這版。」',receiptIntro:'讓核准綁定檔案本身，正確版本就能跟著作品一起走。',step1:'建立檔案指紋',step1Hint:'在本機計算，不上傳檔案。',step2:'記錄這次交付',step2Hint:'一份公開的 devnet 收據。',step3:'確認這個版本',step3Hint:'由指定審閱者簽署。',notRecorded:'尚未記錄至鏈上',draftExplanation:'本機草稿不等於區塊鏈收據。',recordDelivery:'記錄交付 ↗',approveVersion:'核准這個確切版本',exportReceipt:'↓ 匯出收據',viewExplorer:'在 Solana 查看 ↗',testSession:'Devnet 測試工作階段',testExplanation:'為這次瀏覽器工作階段產生臨時創作者與審閱者身分。只用免費測試代幣，不連接真實錢包；重新整理後簽署金鑰即消失。',prepareSession:'建立測試身分',requestCredits:'索取免費測試額度',verifyEyebrow:'驗證檔案，不只看檔名。',verifyHeadline:'這份，<br><span>是定案的那份嗎？</span>',verifyIntro:'帶著收據與原始檔案，確認指紋、審閱者及即時 devnet 紀錄。',importReceipt:'匯入收據',importExplanation:'匯入內容通過檢查前，一律不受信任。收據不含金鑰與原始檔案。',chooseReceipt:'選擇收據 JSON',compareFile:'比對原始檔案',compareExplanation:'在本機重新計算 SHA-256。改名無法讓內容不同的檔案通過。',chooseFile:'選擇原始檔案',checkDevnet:'重新查核 devnet',devnetExplanation:'重新讀取交易，核對備忘、簽署者及最終確認狀態。無法取得的收據仍維持未驗證。',checkLive:'查核即時收據 ↗',footerNote:'早期 devnet 原型。公鑰核准不代表完成法律身分驗證。',about:'運作方式 ↗',sampleMode:'合成示範 · 未上鏈',draft:'草稿',recorded:'已記錄',approved:'已核准',pending:'等待最終確認',chooseFirst:'請先加入一份交付檔案。',sessionReady:'測試身分已建立，金鑰只保留在本次記憶體。',creditsReady:'免費測試額度已就緒。',creditsPending:'測試額度尚待確認，請稍後查核，勿重複索取。',fileAdded:'檔案指紋已在本機計算；檔案沒有上傳。',fileTooLarge:'原型目前支援 64 MiB 以內的檔案。',recordedToast:'交付已在 Solana devnet 最終確認。',approvedToast:'指定審閱者的核准已最終確認。',pendingToast:'交易已送出，尚待最終確認；請勿重送。',sampleTitle:'示範分鏡交付',syntheticFile:'示範分鏡',localTitle:'我的交付',noChain:'尚未上鏈',verifiedChain:'已從 devnet 重新核驗',verifiedHint:'最終確認、備忘與簽署者均相符。',sampleHint:'合成範例沒有真實交易，不可當作核准證明。',localMatched:'檔案內容相符。',localMismatch:'檔案內容不同，無法核准為同一版。',imported:'收據格式有效，尚待原檔與鏈上查核。',noAnchor:'收據沒有鏈上交易；保持未驗證。',checkedLive:'所有交付及核准交易均已最終確認並通過即時核對。',unverifiedLive:'仍有尚未最終確認的交易，不能宣稱驗證完成。',busy:'處理中…',importInvalid:'收據格式不符或內容遭修改。',needSession:'請先在「Devnet 測試工作階段」建立臨時身分。',sampleNoSign:'示範版本無簽署金鑰；請新增你自己的交付。',genericError:'操作未完成，沒有新增已驗證收據。請稍後再試。',publicReceiptNotice:'收據只含內容摘要與公開測試地址；請先確認檔案適合建立公開指紋。',creator:'創作者',reviewer:'審閱者',refreshHint:'工作階段金鑰會在重新整理後消失。'
  },
  ja: {
    workspace:'クリエイティブ・ワークスペース',workspaceLabel:'ワークスペース',deliveries:'納品バージョン',verifyTab:'レシートを検証',localFirst:'ファイルは手元に。',privacy:'元のファイルはブラウザから送信されません。',allProjects:'MICRO USADA の全作品',projectTitle:'名称未設定の納品',eyebrow:'よい納品は、明確さから。',headline:'最終版を、<br><span>本当の決定版に。</span>',intro:'ひとつの版、明確な承認、誰でも確認できるレシート。',tryDemo:'サンプルを見る ↗',newDelivery:'＋ 納品を追加',deliveryDesk:'あなたの納品デスク',localDraft:'ローカル下書き',noFile:'最終ファイルから始める',noFileMeta:'ファイルを追加するか、サンプルをお試しください。',deliveryDocument:'納品ノート',documentTitle:'よい仕事を。<br>明確に届ける。',documentCaption:'クリエイティブの最後の一歩。',previewCaption:'表紙イメージ · 元のファイルはローカルのみ',localOnly:'ローカルのみ',versionHistory:'バージョン履歴',versionHint:'修正ごとに固有の指紋。',noVersions:'ここから最初の納品を。',receiptTitle:'納品レシート',receiptHeadline:'「どの版？」から、<br>「この版。」へ。',receiptIntro:'承認をファイルそのものに紐づけ、正しい版を作品と一緒に届けます。',step1:'ファイルの指紋を作成',step1Hint:'ローカル計算。アップロード不要。',step2:'納品を記録',step2Hint:'公開 devnet レシート。',step3:'このバージョンを承認',step3Hint:'指定レビュアーが署名。',notRecorded:'オンチェーン未記録',draftExplanation:'ローカル下書きはチェーンの証明ではありません。',recordDelivery:'納品を記録 ↗',approveVersion:'この正確なバージョンを承認',exportReceipt:'↓ レシートを書き出す',viewExplorer:'Solana で見る ↗',testSession:'Devnet テストセッション',testExplanation:'このブラウザだけの一時的な制作者とレビュアーを生成します。無料テストトークンのみを使い、実際のウォレットには接続しません。更新すると署名鍵は失われます。',prepareSession:'テスト用 ID を生成',requestCredits:'無料テスト残高をリクエスト',verifyEyebrow:'ファイル名ではなく、中身を確認。',verifyHeadline:'これが、<br><span>あの最終版？</span>',verifyIntro:'レシートと元ファイルから、指紋・レビュアー・最新 devnet 記録を確認。',importReceipt:'レシートを読み込む',importExplanation:'読み込んだ内容は検証前には信頼しません。鍵や元ファイルは含まれません。',chooseReceipt:'レシート JSON を選択',compareFile:'元ファイルを比較',compareExplanation:'ローカルで SHA-256 を再計算。ファイル名の変更だけでは通過できません。',chooseFile:'元ファイルを選択',checkDevnet:'devnet を再検証',devnetExplanation:'取引を再取得し、メモ・署名者・最終確定を確認。取得できないレシートは未検証のままです。',checkLive:'最新レシートを確認 ↗',footerNote:'初期 devnet プロトタイプ。公開鍵の承認は法的な本人確認ではありません。',about:'仕組み ↗',sampleMode:'合成サンプル · 未記録',draft:'下書き',recorded:'記録済み',approved:'承認済み',pending:'最終確定待ち',chooseFirst:'まず納品ファイルを追加してください。',sessionReady:'テスト用 ID を作成しました。鍵はセッションのメモリのみです。',creditsReady:'無料テスト残高の準備ができました。',creditsPending:'残高の確定待ちです。繰り返し請求せず後ほど確認してください。',fileAdded:'ローカルで指紋を計算しました。ファイルは送信していません。',fileTooLarge:'現在の原型は 64 MiB 以下のファイルに対応しています。',recordedToast:'Solana devnet 上の納品が最終確定しました。',approvedToast:'指定レビュアーの承認が最終確定しました。',pendingToast:'取引は送信済み、最終確定待ちです。再送しないでください。',sampleTitle:'サンプル絵コンテの納品',syntheticFile:'サンプル絵コンテ',localTitle:'自分の納品',noChain:'未記録',verifiedChain:'devnet で再検証済み',verifiedHint:'最終確定・メモ・署名者が一致しています。',sampleHint:'合成サンプルに実際の取引はなく、承認の証明にはなりません。',localMatched:'ファイルの内容が一致しました。',localMismatch:'内容が異なります。同じバージョンではありません。',imported:'レシート形式は有効です。元ファイルとチェーン検証は未完了です。',noAnchor:'オンチェーン取引がありません。未検証のままです。',checkedLive:'納品と承認の全取引が最終確定し、最新照合を通過しました。',unverifiedLive:'まだ最終確定していない取引があり、検証完了とは言えません。',busy:'処理中…',importInvalid:'形式が無効か、内容が変更されています。',needSession:'「Devnet テストセッション」で一時 ID を作成してください。',sampleNoSign:'サンプルの署名鍵はありません。自分の納品を追加してください。',genericError:'操作は完了せず、検証済みレシートは追加されていません。後ほどお試しください。',publicReceiptNotice:'公開するのは指紋と公開テストアドレスのみです。公開指紋を作成してよいファイルか確認してください。',creator:'制作者',reviewer:'レビュアー',refreshHint:'ページ更新でセッションの鍵は失われます。'
  }
};
Object.assign(en, {sampleMode:'SYNTHETIC SAMPLE · NOT ON-CHAIN',draft:'Draft',recorded:'Recorded',approved:'Approved',pending:'Awaiting finalization',chooseFirst:'Add a delivery file first.',sessionReady:'Test identities created. Signing keys remain in this session memory only.',creditsReady:'Free test credits are ready.',creditsPending:'Test credits await finalization. Check later instead of requesting again.',fileAdded:'File fingerprint computed locally. The file was not uploaded.',fileTooLarge:'This prototype supports files up to 64 MiB.',recordedToast:'Delivery finalized on Solana devnet.',approvedToast:'Assigned reviewer approval finalized on Solana devnet.',pendingToast:'Transaction sent but not finalized. Do not resend.',sampleTitle:'Sample storyboard delivery',syntheticFile:'Sample storyboard',localTitle:'My delivery',noChain:'Not on-chain',verifiedChain:'Rechecked on devnet',verifiedHint:'Finalization, exact memo and signer match.',sampleHint:'Synthetic examples have no transactions and are not approval evidence.',localMatched:'The original file matches.',localMismatch:'The file content is different. This is not the approved version.',imported:'Receipt format valid. Original file and chain checks still required.',noAnchor:'No on-chain transaction in this receipt. Still unverified.',checkedLive:'All delivery and approval transactions finalized and passed fresh checks.',unverifiedLive:'Some transactions remain unfinalized. Verification is incomplete.',busy:'Working…',importInvalid:'Invalid receipt format or tampered content.',needSession:'Create temporary identities in the devnet test session first.',sampleNoSign:'Samples have no signing keys. Add your own delivery.',genericError:'Operation incomplete. No verified receipt was added. Try again later.',publicReceiptNotice:'Receipts expose a content commitment and public test addresses. Choose a file suitable for a public fingerprint.',creator:'Creator',reviewer:'Reviewer',refreshHint:'Refreshing discards session signing keys.'});

const flowCopy = {
  en: { failed:'Transaction failed', failedToast:'The devnet transaction failed. It is not verified.', recheckDelivery:'Recheck existing transactions', pendingHint:'Keep this receipt. Rechecking reads the same transaction without sending again.', recordedOnlyLive:'The delivery transaction is verified. This version has no approval record.', changesRequestedLive:'The delivery and review transactions are verified. The reviewer requested changes; this version is not approved.', checkedLive:'The latest delivery and its approval both passed fresh devnet checks.', versionLimit:'This prototype supports up to 100 versions per delivery.', imported:'Receipt structure checked. Original-file and devnet verification are still required.', importInvalid:'Receipt rejected. Check the schema, size and record integrity.' },
  'zh-TW': { failed:'交易失敗', failedToast:'Devnet 交易失敗，並未通過驗證。', recheckDelivery:'重新查核既有交易', pendingHint:'請保留這份收據。重新查核只讀取同一筆交易，不會重新送出。', recordedOnlyLive:'交付交易已驗證；這個版本沒有核准紀錄。', changesRequestedLive:'交付與審閱交易已驗證；審閱者要求修改，這個版本尚未核准。', checkedLive:'最新交付及其核准紀錄均已通過即時 devnet 查核。', versionLimit:'這個原型每份交付最多支援 100 個版本。', imported:'收據結構已檢查；仍需核對原檔及即時 devnet 紀錄。', importInvalid:'收據未通過檢查，請確認格式、大小與紀錄完整性。' },
  ja: { failed:'取引失敗', failedToast:'Devnet の取引が失敗しました。検証済みではありません。', recheckDelivery:'既存の取引を再確認', pendingHint:'このレシートを保管してください。再確認は同じ取引を読み取り、再送信しません。', recordedOnlyLive:'納品の取引は検証済みです。この版には承認記録がありません。', changesRequestedLive:'納品とレビューの取引は検証済みですが、修正が要求されており、この版は未承認です。', checkedLive:'最新の納品とその承認記録がライブ devnet 確認を通過しました。', versionLimit:'この試作版では、納品ごとに最大 100 版まで作成できます。', imported:'レシートの構造を確認しました。元ファイルとライブ devnet の確認が必要です。', importInvalid:'レシートを読み込めません。形式、サイズ、記録の整合性を確認してください。' }
};
for (const [language, copy] of Object.entries(flowCopy)) Object.assign(translations[language], copy);
Object.assign(translations.en, { creditsUnavailable:'The free devnet faucet is currently unavailable. No test credits were issued; no payment is requested.', creditsUnknown:'Free test credit status could not be confirmed. No transaction is verified.' });
Object.assign(translations['zh-TW'], { creditsUnavailable:'免費 devnet 領幣服務目前無法使用，尚未取得測試額度；不需要也不會要求付款。', creditsUnknown:'目前無法確認免費測試額度，交易尚未通過驗證。' });
Object.assign(translations.ja, { creditsUnavailable:'無料の devnet faucet は現在利用できず、テスト残高は付与されていません。支払いは不要です。', creditsUnknown:'無料テスト残高を確認できませんでした。取引は未検証です。' });
Object.assign(translations.en, { creditsFailed:'The free test credit transaction failed. No funding was confirmed.' });
Object.assign(translations['zh-TW'], { creditsFailed:'免費測試額度的交易失敗，尚未確認入帳。' });
Object.assign(translations.ja, { creditsFailed:'無料テスト残高の取引が失敗しました。入金は確認されていません。' });
Object.assign(translations.en, { sampleFileReady:'Synthetic original ready to save. The sample remains off-chain.' });
Object.assign(translations['zh-TW'], { downloadSample:'↓ 下載此版示範原檔', sampleFileReady:'合成示範原檔已可儲存；示範仍未上鏈。' });
Object.assign(translations.ja, { downloadSample:'↓ この版のサンプル原本を保存', sampleFileReady:'合成サンプルの原本を保存できます。オンチェーンの記録はありません。' });
let lang = 'en';
let state = { mode: 'local', projectId: randomId(), versions: [], approvals: [], anchors: [], labels: new Map(), selected: 0, identities: null, imported: null };
let toastTimer;
let busy = false;
const t = key => translations[lang][key] ?? en[key] ?? key;
const short = value => value.length > 24 ? value.slice(0,12) + '…' + value.slice(-10) : value;
const current = () => state.versions[state.selected];
const approvalFor = version => state.approvals.find(a => a.versionId === version.versionId && a.decision === 'approved');
const anchorFor = record => record && state.anchors.find(a => a.recordId === (record.approvalId || record.versionId));
function toast(message) { clearTimeout(toastTimer); $('toast').hidden = false; $('toast').textContent = message; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
function setLanguage(value) {
  lang = Object.hasOwn(translations, value) ? value : 'en'; document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.dataset.i18n); });
  render();
}
async function action(button, fn) {
  if (busy) return;
  busy = true;
  const prior = button.textContent; button.disabled = true; button.textContent = t('busy');
  render();
  try { await fn(); } catch (error) { toast(error?.code === 'file-too-large' ? t('fileTooLarge') : t('genericError')); }
  finally { busy = false; button.textContent = button.dataset.i18n ? t(button.dataset.i18n) : prior; render(); }
}
function setReceiptStatus(title, description, verified = false) {
  const target = $('receipt-status'); target.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot';
  if (verified) dot.style.background = '#698447';
  const content = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = title;
  const small = document.createElement('small'); small.textContent = description; content.append(strong, small); target.append(dot, content);
}
function render() {
  const version = current(); const approval = version && approvalFor(version);
  const vAnchor = anchorFor(version); const aAnchor = anchorFor(approval);
  const vVerified = vAnchor?.state === 'rpc-verified'; const aVerified = aAnchor?.state === 'rpc-verified';
  text('version-count', String(state.versions.length));
  text('project-title', state.mode === 'synthetic-demo' ? t('sampleTitle') : state.versions.length ? t('localTitle') : t('projectTitle'));
  text('mode-label', state.mode === 'synthetic-demo' ? t('sampleMode') : t('localDraft'));
  text('file-name', version ? state.labels.get(version.versionId) || t('syntheticFile') + ' ' + version.ordinal : t('noFile'));
  text('file-meta', version ? (version.fileBytes / 1024).toFixed(1) + ' KB · v' + String(version.ordinal).padStart(2,'0') + ' · ' + t('localOnly') : t('noFileMeta'));
  text('file-hash', version?.fileSha256 || '—'); $('file-hash').title = version?.fileSha256 || '';
  text('file-tag', version ? 'V' + String(version.ordinal).padStart(2,'0') : '—');
  const list = $('version-list'); list.replaceChildren();
  if (!state.versions.length) { const empty = document.createElement('div'); empty.className='empty-list'; empty.textContent=t('noVersions'); list.append(empty); }
  [...state.versions].reverse().forEach(record => {
    const index = state.versions.indexOf(record); const row=document.createElement('button'); row.className='version-row' + (index===state.selected ? ' selected':''); row.setAttribute('aria-pressed', String(index===state.selected));
    const order=document.createElement('span'); order.className='version-order'; order.textContent=String(record.ordinal).padStart(2,'0');
    const detail=document.createElement('div'); const title=document.createElement('strong'); title.textContent=state.labels.get(record.versionId)||t('syntheticFile')+' '+record.ordinal; const sub=document.createElement('small'); sub.textContent=short(record.fileSha256); detail.append(title,sub);
    const badge=document.createElement('span'); badge.className='version-state'; const recordAnchor=anchorFor(record); const approveAnchor=anchorFor(approvalFor(record)); badge.textContent=recordAnchor?.state==='failed'||approveAnchor?.state==='failed'?t('failed'):recordAnchor?.state==='rpc-verified'&&approveAnchor?.state==='rpc-verified'?t('approved'):recordAnchor?.state==='rpc-verified'?t('recorded'):recordAnchor?t('pending'):t('draft');
    row.disabled=busy;
    row.append(order,detail,badge); row.onclick=()=>{state.selected=index;render();}; list.append(row);
  });
  text('step1-icon', version ? '✓' : '○'); text('step2-icon', vVerified?'✓':vAnchor?.state==='failed'?'×':vAnchor?'◌':'○'); text('step3-icon',aVerified?'✓':aAnchor?.state==='failed'?'×':aAnchor?'◌':'○');
  text('step2-state', vVerified?t('verifiedHint'):vAnchor?.state==='failed'?t('failed'):vAnchor?t('pending'):t('step2Hint'));
  text('step3-state', aVerified?t('verifiedHint'):aAnchor?.state==='failed'?t('failed'):aAnchor?t('pending'):t('step3Hint'));
  if(vAnchor?.state==='failed'||aAnchor?.state==='failed') setReceiptStatus(t('failed'),t('failedToast'));
  else if (aVerified && vVerified) setReceiptStatus(t('approved'),t('verifiedHint'),true);
  else if (vVerified) setReceiptStatus(t('verifiedChain'),t('verifiedHint'),true);
  else setReceiptStatus(vAnchor?t('pending'):t('notRecorded'),state.mode==='synthetic-demo'?t('sampleHint'):vAnchor?t('pendingHint'):t('draftExplanation'));
  $('anchor-version').disabled = busy || !version || state.mode==='synthetic-demo' || !state.identities || !!vAnchor;
  $('approve-version').disabled = busy || !vVerified || state.mode==='synthetic-demo' || !state.identities || !!aAnchor;
  $('recheck-delivery').hidden = !vAnchor && !aAnchor;
  $('recheck-delivery').disabled = busy || (!vAnchor && !aAnchor);
  $('export-receipt').disabled = busy || !version;
  const hasSampleFile = state.mode === 'synthetic-demo' && state.files?.[state.selected] instanceof Blob;
  $('sample-actions').hidden = !hasSampleFile;
  $('download-sample').disabled = busy || !hasSampleFile;
  $('request-credits').disabled = busy || !state.identities;
  for(const id of ['try-demo','new-delivery','prepare-session','import-receipt']) $(id).disabled=busy;
  const latest = aAnchor || vAnchor; $('explorer-link').hidden = !latest?.signature; if(latest?.signature) $('explorer-link').href='https://explorer.solana.com/tx/'+encodeURIComponent(latest.signature)+'?cluster=devnet';
  if(state.identities) text('identity-addresses', t('creator')+': '+state.identities.creator+'\n'+t('reviewer')+': '+state.identities.reviewer);
  $('verify-file').disabled = busy || !state.imported; $('recheck-record').disabled = busy || !state.imported;
}

$('language').onchange = event => setLanguage(event.target.value);
document.querySelectorAll('[data-view]').forEach(button=>{button.onclick=()=>{
  const verify=button.dataset.view==='verify'; $('verify-view').hidden=!verify; $('delivery-view').hidden=verify;
  document.querySelectorAll('[data-view]').forEach(item=>item.classList.toggle('active',item===button));
};});
$('try-demo').onclick=()=>action($('try-demo'),async()=>{
  const demo=await createDemoWorkspace();
  state={...state,...demo,versions:[...demo.versions],approvals:[...demo.approvals],anchors:[...demo.anchors],labels:new Map(),selected:demo.versions.length-1,identities:state.identities,imported:null};
  for(const id of ['import-state','verify-file-state','network-state']){text(id,'');$(id).className='form-state';}
  toast(t('sampleHint'));
});
$('download-sample').onclick=()=>action($('download-sample'),async()=>{
  const version=current();const file=state.files?.[state.selected];
  if(state.mode!=='synthetic-demo'||!version||!(file instanceof Blob))return;
  const url=URL.createObjectURL(file);const link=document.createElement('a');
  link.href=url;link.download='versionpass-sample-v'+version.ordinal+'.txt';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);toast(t('sampleFileReady'));
});
$('new-delivery').onclick=()=>{
  if(busy)return;
  if(!state.identities){document.querySelector('.test-session').open=true;toast(t('needSession'));return;}
  $('delivery-file').click();
};
$('prepare-session').onclick=()=>action($('prepare-session'),async()=>{state.identities=await createTestIdentities();toast(t('sessionReady'));});
$('request-credits').onclick=()=>action($('request-credits'),async()=>{
  const result=await requestTestCredits();
  toast(t(creditStatusKey(result)));
});
$('delivery-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  await action($('new-delivery'),async()=>{
    if(file.size>MAX_FILE_BYTES){toast(t('fileTooLarge'));return;}
    if(!state.identities){toast(t('needSession'));return;}
    if(state.mode!=='synthetic-demo'&&state.versions.length>=MAX_RECEIPT_VERSIONS){toast(t('versionLimit'));return;}
    const fingerprint=await hashFile(file);
    if(state.mode==='synthetic-demo') state={...state,mode:'local',projectId:randomId(),versions:[],approvals:[],anchors:[],labels:new Map(),files:[],selected:0};
    const previous=state.versions.at(-1);
    const version=await createVersion({projectId:state.projectId,ordinal:state.versions.length+1,fileSha256:fingerprint.sha256,fileBytes:fingerprint.bytes,creatorPublicKey:state.identities.creator,expectedReviewerPublicKey:state.identities.reviewer,previousVersionId:previous?.versionId||null});
    state.versions.push(version);state.labels.set(version.versionId,file.name);state.selected=state.versions.length-1;toast(t('fileAdded'));render();
  });
  event.target.value='';
};
const observationToast = (observation, verified) => t(observation.state==='rpc-verified'?verified:observation.state==='failed'?'failedToast':'pendingToast');
$('anchor-version').onclick=()=>action($('anchor-version'),async()=>{
  const version=current();if(!version)throw new Error('no-version');
  toast(t('publicReceiptNotice'));const observation=await anchorRecord(version,'version');
  state.anchors=upsertObservation(state.anchors,version,observation);toast(observationToast(observation,'recordedToast'));
});
$('approve-version').onclick=()=>action($('approve-version'),async()=>{
  const version=current();const approval=approvalFor(version)||await createApproval({version,reviewerPublicKey:state.identities.reviewer,decision:'approved'});
  if(!state.approvals.some(a=>a.approvalId===approval.approvalId))state.approvals.push(approval);
  const observation=await anchorRecord(approval,'approval',version);state.anchors=upsertObservation(state.anchors,approval,observation);toast(observationToast(observation,'approvedToast'));
});
$('recheck-delivery').onclick=()=>action($('recheck-delivery'),async()=>{
  const version=current();if(!version)return;
  const approval=approvalFor(version);
  for(const record of [version,...(approval?[approval]:[])]){
    const anchor=anchorFor(record);if(!anchor)continue;
    // A recheck has no signing or sending path, even for failed/pending anchors.
    state.anchors=upsertObservation(state.anchors,record,{...anchor,state:'pending'});
    const observation=await checkRecord(record,anchor.signature,version);
    state.anchors=upsertObservation(state.anchors,record,observation);
  }
  const failed=[anchorFor(version),anchorFor(approval)].some(item=>item?.state==='failed');
  toast(t(failed?'failedToast':anchorFor(version)?.state==='rpc-verified'&&(!approval||anchorFor(approval)?.state==='rpc-verified')?approval?'approvedToast':'recordedToast':'pendingToast'));
});
$('export-receipt').onclick=()=>action($('export-receipt'),async()=>{
  const version=current();const approval=approvalFor(version);
  const bundle={kind:'versionpass.receipt-bundle',schema:1,network:'solana-devnet',versions:state.versions.slice(0,state.selected+1),approvals:approval?[approval]:[],anchors:state.anchors.filter(anchor=>[version.versionId,approval?.approvalId].includes(anchor.recordId)).map(anchor=>({recordId:anchor.recordId,signature:anchor.signature}))};
  const blob=new Blob([await serializeReceiptBundle(bundle)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='versionpass-receipt-v'+version.ordinal+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('import-receipt').onclick=()=>$('receipt-file').click();
$('receipt-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  await action($('import-receipt'),async()=>{
    state.imported=null;text('verify-file-state','');text('network-state','');
    $('verify-file-state').className='form-state';$('network-state').className='form-state';
    try{
      state.imported=await parseReceiptFile(file);text('import-state',t('imported'));$('import-state').className='form-state';
    }catch{state.imported=null;text('import-state',t('importInvalid'));$('import-state').className='form-state error';}
  });
  event.target.value='';
};
$('verify-file').onclick=()=>$('verify-file-input').click();
$('verify-file-input').onchange=async event=>{
  const file=event.target.files[0];if(!file||!state.imported)return;
  await action($('verify-file'),async()=>{
    text('verify-file-state',t('busy'));$('verify-file-state').className='form-state';
    try{const result=await verifyFile(state.imported.versions.at(-1),file);text('verify-file-state',t(result.matches?'localMatched':'localMismatch'));$('verify-file-state').className='form-state '+(result.matches?'success':'error');}
    catch{text('verify-file-state',file.size>MAX_FILE_BYTES?t('fileTooLarge'):t('importInvalid'));$('verify-file-state').className='form-state error';}
  });
  event.target.value='';
};
$('recheck-record').onclick=()=>action($('recheck-record'),async()=>{
  const receipt=state.imported;if(!receipt)return;
  const plan=verificationPlan(receipt);const results=[];
  text('network-state',t('busy'));$('network-state').className='form-state';
  try{
    for(const record of plan.records){const id=record.approvalId||record.versionId;const anchor=receipt.anchors.find(a=>a.recordId===id);if(!anchor){text('network-state',t('noAnchor'));$('network-state').className='form-state error';return;}results.push(await checkRecord(record,anchor.signature,plan.version));}
    const summary=liveSummary(plan,results);
    text('network-state',t(summary==='approved'?'checkedLive':summary==='delivery-only'?'recordedOnlyLive':summary==='changes-requested'?'changesRequestedLive':'unverifiedLive'));
    $('network-state').className='form-state '+(summary==='approved'?'success':summary==='unverified'?'error':'');
  }catch{ text('network-state',t('unverifiedLive'));$('network-state').className='form-state error';throw new Error('recheck-unverified'); }
});
setLanguage('en');
