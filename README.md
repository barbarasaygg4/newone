# Sistema de solicitudes en tiempo real

    npm install
    ADMIN_TOKEN=mi-clave-secreta npm start

- Cliente:  http://localhost:3000/
- Panel:    http://localhost:3000/panel.html   (te pide el ADMIN_TOKEN)

Flujo: index.html -> POST /api/solicitudes -> espera.html (SSE) -> panel.html (acciones) -> evento -> espera.html reacciona.
