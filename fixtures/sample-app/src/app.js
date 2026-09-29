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
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
