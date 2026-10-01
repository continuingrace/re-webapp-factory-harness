// 메모 자동 저장·복구 (LocalStorage). 민감정보는 저장하지 않는다.
const KEY = 're-sample-app:note';
const note = document.querySelector('#note');
const preview = document.querySelector('#preview');
const status = document.querySelector('#status');
const clear = document.querySelector('#clear');
const EMPTY = '아직 입력한 메모가 없습니다.';

function render(value) {
  preview.textContent = value || EMPTY;
}

note.value = localStorage.getItem(KEY) || '';
render(note.value);

note.addEventListener('input', () => {
  localStorage.setItem(KEY, note.value);
  render(note.value);
  status.textContent = '자동 저장됨';
});

clear.addEventListener('click', () => {
  note.value = '';
  localStorage.removeItem(KEY);
  render('');
  status.textContent = '지웠습니다';
});

if ('serviceWorker' in navigator) {
  // 이미 이전 service worker가 화면을 제어하던 경우에만, 새 버전이 넘겨받으면 한 번 새로고침한다.
  // (첫 설치의 clients.claim()도 controllerchange를 일으키므로 그때는 새로고침하지 않는다.)
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((registration) => registration.update())
    .catch(() => {});
}
