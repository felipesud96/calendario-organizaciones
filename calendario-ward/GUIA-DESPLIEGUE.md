# Guía paso a paso: publicar OrganizaSion

Esta guía te lleva de "tengo el proyecto en un zip" a "tengo una URL real que cualquiera puede abrir desde su celular". No necesitas saber programar — son formularios y clics, pero hay que hacerlos en orden.

## Cómo va a funcionar una vez publicado

Sí, va a ser una app **online** de verdad: vivirá en un servidor que corre todo el día, con una dirección web propia (algo como `https://calendario-tuobispado.onrender.com`, o un dominio personalizado si más adelante quieres uno).

Cada persona entra desde el navegador de su celular o computador, escribe su correo y contraseña, y ve el calendario según su perfil. No hay una "app" que instalar de la tienda de aplicaciones — es una página web que pueden guardar como acceso directo en la pantalla de inicio del celular (en iPhone: compartir → "Agregar a pantalla de inicio"; en Android: menú del navegador → "Instalar app" o "Agregar a pantalla principal"), y les va a quedar como un ícono normal.

Las cuentas (correo + contraseña) las creas tú desde el panel de Administración → Usuarios, una por cada líder y, si quieres, una por cada miembro que vaya a consultar el calendario. No se conecta con ninguna cuenta de la Iglesia ni con nada externo — son cuentas propias de esta app.

## Antes de empezar

Vas a crear dos cuentas gratuitas (si no las tienes ya):

1. **GitHub** (github.com) — ahí vive el código del proyecto.
2. **Render** (render.com) — el servicio que lo mantiene corriendo 24/7 y le da la URL pública.

Ambas se pueden crear con tu correo normal, gratis, en un par de minutos.

---

## Paso 1: Sube el proyecto a GitHub

1. Entra a [github.com](https://github.com) y crea una cuenta si no tienes (botón "Sign up").
2. Una vez dentro, haz clic en el botón **+** arriba a la derecha → **New repository**.
3. Ponle un nombre, por ejemplo `calendario-organizaciones`. Puedes dejarlo como **Private** (privado) si prefieres que no sea público — Render igual puede acceder a repos privados.
4. Haz clic en **Create repository**.
5. En la página del repositorio recién creado, busca el enlace **"uploading an existing file"** (o el botón **Add file → Upload files**).
6. Descomprime el zip `calendario-ward.zip` en tu computador, y arrastra **todo el contenido de la carpeta** `calendario-ward` (las carpetas `server/`, `client/`, el `README.md`, etc.) a esa página de subida.
7. Baja hasta el final y haz clic en **Commit changes** para guardar.

Al terminar, deberías ver en GitHub las carpetas `server` y `client` dentro de tu repositorio.

---

## Paso 2: Crea el servicio en Render

1. Entra a [render.com](https://render.com) y crea una cuenta — lo más simple es el botón **"Sign up with GitHub"**, así quedan conectados automáticamente.
2. En el panel de Render, haz clic en **New +** → **Web Service**.
3. Elige **Build and deploy from a Git repository** y conecta tu cuenta de GitHub si te lo pide, luego selecciona el repositorio `calendario-organizaciones` que creaste.
4. En el formulario de configuración, completa:
   - **Name**: el nombre que quieras (define parte de la URL, ej. `calendario-tuobispado`).
   - **Region**: la más cercana a Chile (Oregon u otra de EE.UU. suele ser la disponible).
   - **Root Directory**: `server`
   - **Runtime**: `Node`
   - **Build Command**: déjalo vacío (este proyecto no tiene dependencias que instalar).
   - **Start Command**: `node src/server.js`
5. Más abajo, en **Instance Type**, elige el plan **Starter** (de pago, actualmente desde unos USD 7/mes — revisa el precio vigente en render.com/pricing porque puede cambiar). El plan gratuito no sirve para esta app porque no permite disco persistente y se "apaga" tras 15 minutos sin uso, así que los datos se perderían.

No hagas clic en crear todavía — sigue al paso 3 para agregar el disco persistente primero (Render te deja hacerlo en la misma pantalla, en la sección **Advanced**).

---

## Paso 3: Agrega almacenamiento persistente (muy importante)

Sin este paso, cada vez que actualices el código o Render reinicie el servicio, **se borrarían todos los usuarios, actividades y entrevistas**.

1. En la misma pantalla de creación (o después, en tu servicio → pestaña **Disks**), busca **Add Disk** / **Advanced → Add Disk**.
2. Configura:
   - **Name**: `datos` (o el nombre que quieras)
   - **Mount Path**: `/var/data`
   - **Size**: 1 GB está bien de sobra para esta app.
3. Ve a la sección **Environment Variables** del mismo formulario y agrega:
   - **Key**: `DB_PATH`
   - **Value**: `/var/data/db.json`

   (Esto le dice a la app que guarde sus datos dentro del disco persistente en vez del disco temporal del contenedor.)
4. Ahora sí, haz clic en **Create Web Service**.

Render va a clonar tu repositorio y arrancar el servidor. Esto toma uno o dos minutos la primera vez. Puedes ver el progreso en la pestaña **Logs**; cuando aparezca una línea como `Servidor de OrganizaSion escuchando en...`, ya está listo.

---

## Paso 4: Crea los datos iniciales (organizaciones y usuarios)

La primera vez que se despliega, la base de datos está vacía (no trae las 8 organizaciones ni los usuarios de ejemplo, porque nunca corriste `node src/seed.js` en el servidor). Tienes dos formas de resolverlo:

**Opción simple:** en Render, ve a tu servicio → pestaña **Shell** (una terminal dentro de tu propio servidor) y ejecuta:
```
node src/seed.js
```
Esto crea las 8 organizaciones y las cuentas de ejemplo (admin, un líder por organización, un miembro). Luego entras con `admin@ward.local` / `admin123` y desde ahí ya puedes cambiar contraseñas y crear las cuentas reales.

**Opción alternativa:** entra directamente a la URL pública que te dio Render, inicia sesión como si tuvieras las cuentas de ejemplo (fallará, porque aún no existen) — por eso la opción del Shell es la recomendada.

---

## Paso 5: Deja todo listo para uso real

1. Entra a la URL pública (Render te la muestra arriba en el panel, algo como `https://calendario-tuobispado.onrender.com`).
2. Inicia sesión como `admin@ward.local` / `admin123`.
3. Ve a **Administración → Usuarios** y:
   - Cambia la contraseña del administrador (edítate a ti mismo).
   - Crea una cuenta real para cada líder de organización (con su nombre y correo real).
   - Elimina o desactiva las cuentas de ejemplo que no vayas a usar.
4. Comparte la URL con los líderes junto con su correo y contraseña.

---

## Habilitar la lectura automática de PDF (Crecimiento del Barrio)

La sección "Crecimiento del Barrio" te deja subir el PDF del informe trimestral y precargar el formulario automáticamente (igual siempre tienes que revisar y apretar Guardar — nunca se guarda solo). Para que esa lectura automática funcione, el servidor necesita dos programas instalados que **el servicio de Render que armaste en el Paso 2 no trae** (es un servicio "Node nativo", y esos dos programas no son de Node, son del sistema operativo). Si no haces este paso, la app sigue funcionando igual en todo lo demás — el botón de subir PDF va a aparecer, pero va a caer siempre al aviso de "completar manualmente".

Esto significa cambiar el **tipo de servicio** en Render de "Node nativo" a "Docker" (así se pueden instalar esos dos programas). La forma más simple y segura es crear un servicio nuevo al lado del que ya tienes, probarlo, y recién ahí decidir si apagas el viejo — así nunca te quedas sin la app funcionando mientras haces el cambio.

### Paso A: sube el Dockerfile a GitHub

Te voy a dar 3 archivos nuevos: `Dockerfile`, `.dockerignore` y un `.gitignore` actualizado (van en la raíz del repositorio, al mismo nivel que las carpetas `server` y `client`, reemplazando el `.gitignore` que ya tenías). Súbelos a tu repositorio de GitHub con el mismo método del Paso 1 (Add file → Upload files → Commit changes).

### Paso B: crea el servicio Docker en Render

1. En el panel de Render, **New +** → **Web Service**.
2. Elige el mismo repositorio de GitHub de siempre.
3. Esta vez, en **Language/Runtime** (o **Environment**, según la versión del panel que te muestre Render) elige **Docker** en vez de Node.
4. Completa:
   - **Name**: algo distinto al servicio viejo, por ejemplo `calendario-tuobispado-v2` (para no pisarlo mientras pruebas).
   - **Region**: la misma que usaste antes.
   - **Dockerfile Path**: `./Dockerfile`
   - **Docker Build Context Directory**: `.` (un punto, significa "la raíz del repositorio").
5. Repite el **Paso 3** de esta guía (Add Disk con Mount Path `/var/data`, tamaño 1 GB, y la variable de entorno `DB_PATH` = `/var/data/db.json`) — es exactamente igual que antes, Docker no cambia esta parte.
6. Crea el servicio y espera a que termine de construir la imagen (la primera vez tarda más que el servicio Node nativo, un poco más de 5 minutos, porque tiene que instalar los programas de OCR).
7. Corre `node src/seed.js` desde la pestaña **Shell** del servicio nuevo (igual que en el Paso 4) para crear las organizaciones, los usuarios de ejemplo, y los 6 trimestres + la instantánea de "Crecimiento del Barrio" que ya vienen precargados en el código.

### Paso C: prueba el OCR antes de apagar el servicio viejo

Entra a la URL del servicio nuevo, inicia sesión como admin, ve a **Crecimiento del Barrio → Cargar trimestre nuevo**, y sube cualquiera de tus PDF de informes trimestrales reales para confirmar que se lee solo. Si algo no se lee bien, va a aparecer como aviso arriba del formulario en vez de guardarse mal — nunca se guarda un número sin que lo revises.

Cuando confirmes que anda bien: repite el **Paso 5** de esta guía en el servicio nuevo (cambiar contraseña de admin, crear cuentas reales, borrar cuentas de ejemplo), comparte la URL nueva con los líderes, y recién ahí borra o pausa el servicio viejo en Render para no seguir pagando por los dos.

### Nota sobre el idioma del OCR

El Dockerfile instala el paquete de idioma español de Tesseract (`tesseract-ocr-spa`), así que los nombres con tildes y ñ de la tabla de conversos se van a leer bien en este servicio Docker — a diferencia de las pruebas que hice yo en mi propio entorno de desarrollo, donde ese paquete no se pudo instalar y por eso algunos nombres salían sin tilde en las pruebas. Los números (las columnas Real/Potencial) nunca dependen del idioma, así que esa parte siempre fue exacta.

---

## Después de esto

- **Actualizar el código más adelante**: si en el futuro quieres que te ayude a agregar algo nuevo, subes los archivos actualizados a GitHub (reemplazando los antiguos) y Render vuelve a desplegar automáticamente en un par de minutos.
- **Dominio propio**: si más adelante quieres algo como `calendario.tuobispado.cl` en vez de la URL de Render, se puede conectar un dominio propio desde la pestaña **Settings → Custom Domains** de tu servicio en Render (el dominio hay que comprarlo aparte, en cualquier proveedor).
- **Costo mensual aproximado**: el plan Starter de Render (~USD 7/mes) más el disco persistente (~USD 0.25/mes por 1 GB) — verifica los precios vigentes en [render.com/pricing](https://render.com/pricing) porque pueden variar.

Si en cualquier paso algo no calza con lo que ves en pantalla (Render actualiza su interfaz de vez en cuando), dime exactamente en qué paso estás y qué ves, y seguimos desde ahí.
