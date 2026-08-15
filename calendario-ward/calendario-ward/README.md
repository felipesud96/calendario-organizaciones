# Calendario de Organizaciones

Aplicación web para coordinar las actividades semanales de todas las organizaciones del barrio/rama (Obispado, Cuórum de Élderes, Sociedad de Socorro, Escuela Dominical, Hombres Jóvenes, Mujeres Jóvenes, JAS y Primaria) en un solo calendario compartido, más una sección de Entrevistas para que los líderes agenden citas con los miembros.

Interfaz en blanco y celeste, con un color distintivo por organización.

## Cómo funciona

- **Calendario**: todos los usuarios ven todas las actividades de todas las organizaciones, coloreadas según a quién pertenecen. Cada actividad tiene día, horario, lugar, descripción y organización. Se puede navegar con las flechas, saltar directo a un mes/año con los menús desplegables, o ir a una fecha específica con el selector "Ir a fecha".
- **Entrevistas**: sección aparte donde los líderes de Obispado, Cuórum de Élderes y Sociedad de Socorro agendan entrevistas con miembros (nombre del miembro, día, horario, lugar, descripción). Las entrevistas también aparecen en el calendario general (con un ícono 👤) para que nadie agende una actividad encima.
- **Perfiles / roles**:
  - **Administrador**: ve y edita todo, y además gestiona los perfiles (usuarios) y las organizaciones.
  - **Líder**: ve todo el calendario, y puede crear/editar/eliminar tanto actividades como entrevistas de su propia organización (las entrevistas solo aplican si su organización es Obispado, Cuórum de Élderes o Sociedad de Socorro).
  - **Miembro**: solo puede consultar el calendario y las entrevistas, sin editar nada.

## Tecnología

Este proyecto se construyó **sin dependencias externas**: el backend usa únicamente el runtime estándar de Node.js (`http`, `crypto`, `fs`) y el frontend es HTML/CSS/JavaScript puro, sin frameworks ni paso de compilación. Esto lo hace muy liviano y fácil de desplegar en cualquier lugar que corra Node 18+, sin `npm install` y sin sorpresas de versiones de paquetes.

- `server/` — API REST (autenticación, organizaciones, eventos, entrevistas, usuarios) y guarda los datos en `server/data/db.json`.
- `client/public/` — la interfaz web (se sirve directamente desde el mismo servidor).

> Nota técnica: los datos se guardan en un archivo JSON en vez de una base de datos SQL tradicional. Para el tamaño de un barrio (decenas de usuarios, cientos de eventos al año) esto funciona perfectamente bien y evita instalar un motor de base de datos. Si en el futuro el proyecto crece mucho, migrar `server/src/db.js` a Postgres/MySQL es un cambio acotado porque el resto del código solo llama a `load()` / `save()` / `withDb()`.

## Cómo correrlo localmente

Requisitos: [Node.js](https://nodejs.org) 18 o superior (no necesitas instalar nada más).

```bash
cd server
node src/seed.js   # crea las 8 organizaciones y usuarios de ejemplo (solo la primera vez)
node src/server.js # inicia el servidor en http://localhost:4000
```

Abre `http://localhost:4000` en tu navegador.

### Usuarios de ejemplo (creados por el seed)

| Rol | Email | Contraseña |
|---|---|---|
| Administrador | admin@ward.local | admin123 |
| Líder (uno por organización; en Obispado, Cuórum de Élderes y Sociedad de Socorro también agenda entrevistas) | lider.obispado@ward.local, lider.primaria@ward.local, etc. | lider123 |
| Miembro | miembro@ward.local | miembro123 |

**Importante:** cambia estas contraseñas (o crea usuarios nuevos y elimina estos) antes de usar la app con datos reales, desde el panel de Administración → Usuarios.

## Cómo desplegarlo para que todos lo usen desde su celular

Como pediste una app real multiusuario, necesitas subir este proyecto a un servicio que lo mantenga corriendo 24/7 con una URL pública. Las opciones más simples y gratuitas/económicas para un proyecto de este tamaño:

### Opción recomendada: Render.com

1. Crea una cuenta gratuita en [render.com](https://render.com) y sube este proyecto a un repositorio de GitHub (puedes arrastrar la carpeta a github.com/new o usar `git init` / `git push`).
2. En Render, "New +" → "Web Service" → conecta tu repositorio.
3. Configuración:
   - **Root Directory**: `server`
   - **Build Command**: (déjalo vacío, no hay dependencias que instalar)
   - **Start Command**: `node src/server.js`
4. En "Environment", agrega la variable `CLIENT_DIR` con el valor `/opt/render/project/src/client/public` (o deja el valor por defecto si Render respeta la misma estructura de carpetas; si la interfaz no carga, ajusta esta ruta).
5. **Muy importante**: agrega un "Persistent Disk" (Render lo ofrece en el plan pagado desde ~US$1/mes, o revisa su capa gratuita vigente) montado en `server/data`, para que los eventos y usuarios no se borren cada vez que el servicio se reinicia o se actualiza el código. Sin esto, los datos viven solo mientras el contenedor no se reinicie.
6. Una vez desplegado, entra a la URL que te da Render, inicia sesión con `admin@ward.local` / `admin123` y cambia esa contraseña de inmediato.

### Alternativas

- **Railway.app**: proceso muy similar a Render, con volúmenes persistentes también disponibles.
- **Un VPS económico** (DigitalOcean, un servidor casero, etc.): instala Node 18+, copia la carpeta `server/` y `client/`, corre `node src/server.js` con un gestor de procesos como `pm2` para que se reinicie solo, y pon un dominio o subdominio apuntando a él con Nginx/Caddy como proxy con HTTPS.

En cualquier caso, lo único que de verdad importa es: (1) que el proceso de Node se mantenga corriendo, y (2) que la carpeta `server/data` sea un disco persistente y no se borre en cada despliegue.

Si prefieres que te ayude a dejarlo funcionando en un dominio real paso a paso (comprando/registrando el servicio, conectando el repositorio, configurando el disco persistente), dímelo y lo hacemos juntos.

## Estructura del proyecto

```
calendario-ward/
├── server/
│   ├── src/
│   │   ├── server.js         # servidor HTTP + enrutador
│   │   ├── router.js         # mini router (sin Express)
│   │   ├── db.js             # capa de almacenamiento (JSON)
│   │   ├── auth.js           # hash de contraseñas y sesiones
│   │   ├── guard.js          # helpers de permisos por rol
│   │   ├── seed.js           # datos de ejemplo
│   │   └── routes/
│   │       ├── auth-routes.js
│   │       ├── organizations.js
│   │       ├── events.js
│   │       ├── interviews.js
│   │       └── users.js
│   └── data/db.json          # "base de datos" (se crea automáticamente)
└── client/
    └── public/
        ├── index.html
        ├── styles.css         # tema blanco y celeste
        └── app.js              # toda la lógica de la interfaz
```
