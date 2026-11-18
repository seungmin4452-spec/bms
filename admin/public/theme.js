// 화면 테마: 기본은 다크. 저장값이 있으면 그것을 쓴다 ('light' | 'light dark'(시스템 따라가기)).
// CSP 때문에 인라인 스크립트를 못 써서 <head> 안에서 동기로 불러오는 작은 파일로 둔다 (깜빡임 방지).
(function () {
  var v = null;
  try { v = localStorage.getItem('color-scheme'); } catch (e) { /* 저장소 차단 */ }
  if (v === 'light' || v === 'light dark') document.querySelector('meta[name="color-scheme"]').content = v;
})();
