// Единое соединение Socket.io для всей панели управления.
// Библиотека клиента отдаётся самим сервером по пути /socket.io/socket.io.js
// (подключена тегом <script> в index.html до этого модуля).
export const socket = window.io();
