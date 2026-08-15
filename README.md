# Calendario Barrio Valle Grande

Aplicación web para coordinar las actividades semanales de todas las organizaciones del barrio/rama (Obispado, Cuórum de Élderes, Sociedad de Socorro, Escuela Dominical, Hombres Jóvenes, Mujeres Jóvenes, JAS y Primaria) en un solo calendario compartido, más una sección de Entrevistas para que los líderes agenden citas con los miembros.

Interfaz en blanco y celeste, con un color distintivo por organización.

## Cómo funciona

- **Calendario**: todos los usuarios ven todas las actividades de todas las organizaciones, coloreadas según a quién pertenecen. Cada actividad tiene día, horario, lugar, descripción y organización. Se puede navegar con las flechas, saltar directo a un mes/año con los menús desplegables, o ir a una fecha específica con el selector "Ir a fecha".
- **Entrevistas**: sección aparte donde los líderes de Obispado, Cuórum de Élderes y Sociedad de Socorro agendan entrevistas con miembros (nombre del miembro, día, horario, lugar, descripción, y qué líder la realizará con su email/WhatsApp de contacto). Las entrevistas también aparecen en el calendario general (con un ícono 👤) para que nadie agende una actividad encima.
- **Recordatorios automáticos por email**: cada 15 minutos el servidor revisa qué entrevistas empiezan en ~24 horas y le envía un correo automático al líder que la va a realizar (usando Resend). Ver "Recordatorios automáticos de entrevistas" más abajo para activarlo.
- **Entrevistas — privacidad**: las entrevistas son información privada de los miembros.
  - El perfil **Miembro** no ve la sección de Entrevistas en absoluto.
  - Cada **Líder** solo ve las entrevistas de su propia organización.
  - Excepción: el **Líder de Obispado** sí puede ver las entrevistas agendadas por Cuórum de Élderes y Sociedad de Socorro además de las suyas (para tener panorama completo desde el Obispado).
- **Perfiles / roles**:
  - **Administrador**: ve y edita todo, y además gestiona los perfiles (usuarios) y las organizaciones.
  - **Líder**: ve todo el calendario, y puede crear/editar/eliminar tanto actividades como entrevistas de su propia organización (las entrevistas solo aplican si su organización es Obispado, Cuórum de Élderes o Sociedad de Socorro).
  - **Miembro**: solo puede consultar el calendario, sin editar nada y sin ver la sección de Entrevistas.

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

Ver el archivo **`GUIA-DESPLIEGUE.md`** en la raíz del proyecto: tiene el paso a paso completo (GitHub → Render, disco persistente, variables de entorno, creación de usuarios reales) explicado para alguien que no programa.

En resumen, lo único que de verdad importa es: (1) que el proceso de Node se mantenga corriendo 24/7 (por eso se recomienda el plan Starter de Render y no el gratuito, que se apaga solo), y (2) que los datos se guarden en un disco persistente y no se borren en cada despliegue (por eso se configura la variable `DB_PATH` apuntando al disco).

## Recordatorios automáticos de entrevistas (por email, vía Resend)

Ya está implementado: el servidor revisa cada 15 minutos qué entrevistas empiezan en ~24 horas y, si tienen el email del líder cargado, le envía un correo automático con los datos (miembro, fecha, hora, lugar, detalle). Cada entrevista solo dispara **un** recordatorio (no se repite), y si editas la fecha/hora/email de una entrevista después de enviado el recordatorio, se vuelve a habilitar para la nueva fecha.

Se eligió **email con Resend** por ser la opción más rápida y sencilla de activar (capa gratuita, sin costo, y se integra con una sola llamada HTTP — sin necesidad de instalar paquetes). WhatsApp queda descartado por ahora: requiere verificación de negocio con Meta, un número dedicado y plantillas pre-aprobadas, lo que toma días y no es "rápido y sencillo".

**Para activarlo, solo te falta hacer esto (una sola vez):**

1. Crea una cuenta gratis en [resend.com](https://resend.com) (no pide tarjeta de crédito para el plan gratis).
2. En el panel de Resend, ve a **Domains** y agrega un dominio propio que puedas verificar (por ejemplo `tubarrio.org`, si tienes uno). Resend te da 2-3 registros DNS (TXT/CNAME) para agregar en el proveedor donde compraste el dominio; una vez verificado (puede tardar unos minutos a un par de horas), ya puedes enviar correos a cualquier dirección.
   - Si no tienes un dominio propio, se puede comprar uno barato (~USD 10–15/año) en cualquier registrador (Namecheap, Google Domains, etc.) solo para esto.
3. En el panel de Resend, ve a **API Keys** y crea una nueva key (cópiala, no se vuelve a mostrar completa).
4. En Render, ve a tu servicio → **Environment** y agrega estas dos variables:
   - `RESEND_API_KEY` = la key que copiaste.
   - `REMINDER_FROM_EMAIL` = una dirección de tu dominio verificado, por ejemplo `Calendario Barrio Valle Grande <recordatorios@tubarrio.org>`.
5. Guarda — Render reinicia el servicio solo. Desde ese momento, cualquier entrevista que tenga el email del líder cargado va a recibir su recordatorio 24 horas antes automáticamente.

El plan gratis de Resend permite 3.000 correos al mes (100 por día), muy por sobre lo que necesita un barrio. Si no configuras estas variables, la app sigue funcionando normal — simplemente los recordatorios quedan desactivados (se ve un aviso en los logs del servidor, sin errores para los usuarios).

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
