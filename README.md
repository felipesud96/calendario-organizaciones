# Calendario Barrio Valle Grande

Aplicación web para coordinar las actividades semanales de todas las organizaciones del barrio/rama (Obispado, Cuórum de Élderes, Sociedad de Socorro, Escuela Dominical, Hombres Jóvenes, Mujeres Jóvenes, JAS y Primaria) en un solo calendario compartido, más una sección de Entrevistas para que los líderes agenden citas con los miembros.

Interfaz en blanco y celeste, con un color distintivo por organización.

## Cómo funciona

- **Calendario**: todos los usuarios ven todas las actividades de todas las organizaciones, coloreadas según a quién pertenecen. Cada actividad tiene día, horario, lugar, descripción y organización. Se puede navegar con las flechas, saltar directo a un mes/año con los menús desplegables, o ir a una fecha específica con el selector "Ir a fecha".
- **Mis Actividades**: sección aparte con un listado simple (agrupado por fecha) de actividades, sin tener que navegar mes a mes por el calendario.
  - Para el perfil **Líder**: muestra todas las actividades de su propia organización, y desde ahí mismo se agrega y edita con un clic en cualquier actividad de la lista.
  - Para el perfil **Miembro**: la persona elige qué organizaciones le interesa seguir (por ejemplo, la del cuórum al que pertenece, más la de Primaria y Hombres Jóvenes si tiene hijos en esas organizaciones) marcando casillas en "⚙️ Elegir organizaciones", y el listado se arma automáticamente con las actividades de esas organizaciones. La selección queda guardada y se puede cambiar cuando quiera. Las **actividades de todo el Barrio** 🏘️ siempre aparecen en este listado, sin importar qué organizaciones haya marcado. Es solo de lectura: el Miembro puede ver el detalle de cada actividad, pero no editarla ni eliminarla.
- **Lugar estandarizado**: al agendar una actividad o entrevista, el campo Lugar es un selector con tres opciones: **Casa Capilla**, **Capilla**, u **Otro** (con un campo de texto para escribirlo). Esto estandariza los lugares más usados y además es lo que permite que la alerta de choques (ver siguiente punto) compare lugares de forma confiable.
- **Alerta de choque de horario/lugar**: al agendar o editar una actividad o entrevista, si el mismo día choca con una **actividad de otra organización** — ya sea porque el horario se superpone o porque es exactamente el mismo lugar (aunque el horario sea distinto) — aparece una advertencia mostrando con qué organización, actividad, horario y lugar choca, antes de guardar. No bloquea el guardado: si de todas formas quieres agendarlo, presionas el botón de guardar una segunda vez ("Agendar de todas formas"). Esta alerta solo compara contra actividades (no contra entrevistas de otras organizaciones, que son privadas).
- **Actividades en conjunto con otras organizaciones**: al crear o editar una actividad, además de elegir la organización principal se puede marcar con casillas qué **otras organizaciones participan también** (por ejemplo, una actividad conjunta de Hombres Jóvenes y Mujeres Jóvenes). Esto se puede agregar desde el inicio o sumarlo después editando la actividad. Las organizaciones marcadas como "involucradas" aparecen con un ícono 🤝 junto al detalle de la actividad, y **no disparan la alerta de choque entre sí**: dos actividades que comparten alguna organización (principal o involucrada) nunca se consideran un choque, aunque tengan el mismo horario o lugar. Eso sí, solo el líder de la organización principal (o un administrador) puede editar o eliminar la actividad — a las organizaciones involucradas les aparece en su propia sección "Mis Actividades" para que la vean, pero sin poder modificarla.
- **Actividad de todo el Barrio**: para actividades donde participa todo el barrio (por ejemplo, una Noche de Hogar combinada o una actividad de barrio general), hay una casilla **"🏘️ Actividad de todo el Barrio"** que reemplaza tener que marcar organización por organización — con un solo clic queda anotada para todas. Aparece automáticamente en el listado "Mis Actividades" de cada líder, y en el calendario se distingue con la etiqueta "🏘️ Actividad de todo el Barrio" en vez de listar cada organización. A diferencia de las actividades en conjunto, esta opción **no desactiva la alerta de choque**: si otra organización agenda algo distinto a la misma hora o en el mismo lugar, la advertencia igual aparece, porque justamente para eso sirve — avisar que ya hay algo de todo el barrio agendado en ese horario.
- **Reuniones (privadas) vs. Actividades (públicas)**: al crear o editar una actividad, un selector "Tipo" permite elegir entre **Actividad** (la ve todo el barrio, como hasta ahora) o **🔒 Reunión** (por ejemplo, "Reunión de presidencia de Cuórum"). Una Reunión solo la ven — en el calendario y en "Mis Actividades" — los líderes (y el administrador) de las organizaciones incluidas: la organización que la creó, las que se marcaron como "involucradas" si es una reunión en conjunto, o todos los líderes del barrio si además se marca "🏘️ Actividad de todo el Barrio" (por ejemplo, un "Consejo de Barrio"). Ni el perfil Miembro ni los líderes de otras organizaciones la ven en ningún lado — el filtro lo aplica el propio servidor, no es solo algo visual. Se distingue con un candado 🔒 en el título dondequiera que aparezca.
- **Repetición de actividades y reuniones**: como las reuniones de presidencia suelen ser periódicas, al crear una actividad o reunión (no al editarla) se puede elegir "Repetición": **Semanal** (se generan automáticamente todas las ocurrencias, el mismo día de la semana, hasta la fecha que indiques) o **Fechas específicas** (agregas a mano cada fecha puntual — por ejemplo, para un taller: viernes de esta semana, jueves de la próxima, sábado en 3 semanas más). Cada ocurrencia queda como una actividad independiente — se puede editar o eliminar una fecha puntual después sin afectar a las demás. La alerta de choque solo revisa la primera fecha al crear; conviene revisar las demás fechas a mano si hace falta.
- **Entrevistas**: sección aparte donde los líderes de Obispado, Cuórum de Élderes y Sociedad de Socorro agendan entrevistas con miembros (nombre del miembro, día, horario, lugar, descripción, y qué líder la realizará), con el email de contacto de **los dos participantes**: el líder que la realiza y el miembro que asiste. Las entrevistas también aparecen en el calendario general (con un ícono 👤) para que nadie agende una actividad encima.
- **Vincular la entrevista a un miembro ya registrado**: hay un solo campo "Miembro" que sirve para las dos cosas — buscar y escribir el nombre. Al tipear (o parte del nombre, sin importar tildes/mayúsculas) aparecen debajo las coincidencias entre todos los usuarios ya registrados en el sistema para hacer clic — pensado para que siga siendo manejable aunque el barrio tenga más de 100 miembros, a diferencia de una lista larga para revisar entera. **Incluye tanto a Miembros como a Líderes y al Administrador**, así que un líder puede entrevistar a otro líder de otra organización (por ejemplo, el líder de Obispado entrevistando al líder de Cuórum de Élderes, o viceversa) buscándolo ahí. Si la persona todavía no tiene cuenta, o no aparece ninguna coincidencia, lo que el líder haya escrito en ese mismo campo queda tal cual como nombre del miembro — no hay un campo aparte de respaldo. Al hacer clic en un resultado, ese campo queda marcado con un chip "🔗 Vinculado a [nombre]" (con la opción "Quitar / escribir a mano" para deshacerlo y volver a tipear), esa entrevista queda vinculada a su cuenta y **le aparece automáticamente en su propia sección "Mis Actividades"** (con un ícono 👤 y el detalle de quién la realiza) — esto aplica tanto si es Miembro como si es Líder, aunque la entrevista la haya agendado una organización distinta a la suya. Un líder ve así, en un solo lugar, tanto sus propias actividades como las entrevistas en las que a él lo entrevistan. En el listado de Entrevistas, las que están vinculadas a un usuario registrado se marcan con "🔗 registrado". El campo "Líder que realizará la entrevista" (entrevistador) sigue siendo de texto libre — no está restringido a ningún rol — y se autocompleta con tu propio nombre al crearla.
- **Exportar "Mis Actividades" a un calendario personal**: desde el botón "📅 Exportar a mi calendario" en "Mis Actividades" (disponible tanto para Líder como para Miembro), la app genera un enlace personal y privado (formato .ics / iCalendar estándar) con exactamente el mismo contenido que ves en esa sección — tus actividades más tus propias entrevistas. Ese enlace se agrega como una **suscripción de calendario** en Google Calendar ("Otros calendarios" → "Desde URL"), Apple Calendar ("Nueva suscripción de calendario…") u Outlook ("Suscribirse desde la web"), y desde ahí se mantiene sincronizado solo — cada app revisa el enlace cada cierto tiempo (usualmente cada pocas horas) y trae lo nuevo, sin tener que exportar de nuevo a mano. El botón también ofrece "Copiar enlace" y "Descargar archivo .ics" (para una importación única, si se prefiere eso a una suscripción). El enlace es privado — quien lo tenga puede ver esas actividades y entrevistas — así que hay un botón "Generar un enlace nuevo" para invalidar el anterior si hiciera falta. *(En el demo de un solo archivo, sin servidor real que aloje el enlace, el mismo botón ofrece una descarga única del .ics con el mismo contenido — sin sincronización automática, ya que eso requiere un enlace que la app de calendario pueda volver a consultar por su cuenta.)*
- **Notificaciones automáticas por email**: si cargaste el email del líder y/o del miembro al agendar la entrevista, ambos reciben automáticamente (desde una cuenta de Gmail):
  - un **recordatorio** 24 horas antes de la entrevista;
  - un aviso de **cancelación** si la entrevista se elimina;
  - un aviso de **cambio de fecha/horario** si se reprograma (edición del día u hora).

  Cada aviso se envía solo a quien tenga su email cargado (si falta el de alguno de los dos, simplemente no le llega a esa persona). Ver "Recordatorios automáticos de entrevistas" más abajo para activarlo.
- **Entrevistas — privacidad**: las entrevistas son información privada de los miembros.
  - El perfil **Miembro** no ve la sección de Entrevistas en absoluto.
  - Cada **Líder** solo ve las entrevistas de su propia organización.
  - Excepción: el **Líder de Obispado** sí puede ver las entrevistas agendadas por Cuórum de Élderes y Sociedad de Socorro además de las suyas (para tener panorama completo desde el Obispado).
- **Presupuesto (trimestral)**: pestaña "Presupuesto" (Líder y Administrador; los Miembros no la ven). El presupuesto se organiza por **categorías** — cada organización del barrio es una categoría, y además el líder de Obispado puede crear categorías extra que no son de una sola organización (por defecto ya viene creada "Actividades de Barrio"; se pueden agregar más, como "Mantenimiento del edificio", con el botón "+ Nueva categoría"). Cada categoría muestra su **monto asignado**, sus **gastos** y su **saldo** (asignado − gastado) del trimestre.
  - **Solo el líder de Obispado** (o el Administrador) puede **asignar** el monto de cada categoría — incluida la de su propia organización — desde un campo numérico en cada tarjeta con el botón "Guardar asignación". Es la única persona con esta "opción de distribución"; ningún otro líder puede asignar montos, ni siquiera al suyo propio.
  - **Cada líder** (de cualquier organización) puede **registrar gastos** solo en la categoría de su propia organización — con monto, descripción, fecha y, opcionalmente, un enlace 🔗 a una actividad que ya haya creado (para dejar registrado en qué actividad se gastó). El líder de Obispado, además de los gastos de su propia organización, también puede registrar gastos en **cualquier categoría personalizada de todo el Barrio** (como "Actividades de Barrio") — pero no en la categoría de otra organización, esa la administra solo el líder correspondiente.
  - Cualquier líder puede **editar o eliminar** un gasto que haya registrado en una categoría donde tiene permiso, mientras siga siendo del **trimestre actual**.
  - **Renovación trimestral automática**: el presupuesto se organiza en trimestres (ej. "3° trimestre 2026"). Al empezar un trimestre nuevo, cada categoría simplemente parte en $0 asignado y $0 gastado — no hace falta ningún proceso manual de "reinicio". Un selector de trimestre en la parte de arriba permite volver a ver cualquier trimestre anterior **a modo de historial de consulta**: los gastos y asignaciones de trimestres pasados no se borran nunca y quedan disponibles para revisar, pero no se editan (no hay botones de guardar/agregar/editar/eliminar) ni se cuentan en el saldo del trimestre actual.
- **Calendario de Estaca (sincronizado automáticamente)**: la Estaca es el grupo de barrios al que pertenece el tuyo. La app se sincroniza sola cada 4 horas con el calendario público (.ics) de la Estaca en el sitio de la Iglesia y muestra esas actividades — con ícono 🏛️ — en el calendario, visibles para todos los perfiles. No todas pesan igual:
  - Las que involucran coordinación real entre barrios (conferencias de estaca, festivales, capacitaciones, días de servicio, etc.) **tienen prioridad**: nadie puede agendar ni editar una actividad de organización o de todo el Barrio que choque en día y horario con ellas, **salvo que el líder de Obispado (o el Administrador) lo autorice** — a diferencia de la alerta de choque entre organizaciones (que cualquiera puede confirmar igual), acá solo esa persona puede "agendar de todas formas". Si una de estas actividades no tiene horario (dura "todo el día"), bloquea el día completo; y en una serie de actividades repetidas, si una sola fecha choca se rechaza la serie completa (salvo autorización).
  - Las que son puramente internas de la Estaca (entrevistas, reuniones de presidencia de Estaca, de sumo consejo, presentación anual de la Primaria, etc.) son **solo informativas**: se muestran en el calendario con un estilo más discreto (borde punteado) pero no bloquean nada — no tiene sentido que compitan por horario con las actividades del barrio.
  - Qué cuenta como "informativa" se decide comparando el título de la actividad contra una lista de palabras clave (por defecto: "entrevista", "presidencia de estaca", "sumo consejo", "presentación anual") — el Administrador (o el líder de Obispado) puede ajustar esa lista en Administración → Estaca, además del enlace de suscripción y el nombre a mostrar, y forzar una sincronización manual con "Sincronizar ahora". El resto de los perfiles solo ven el resultado ya sincronizado, sin poder tocar la configuración.
  - Ahí mismo hay una casilla **"Mostrar en el calendario las actividades informativas de Estaca"**: si el Administrador la desmarca, esas actividades (las que no influyen a la membresía del Barrio) directamente dejan de aparecer en el calendario de todos los perfiles — solo quedan visibles las que sí tienen prioridad. No cambia el bloqueo en absoluto: las informativas nunca bloquearon nada, esta casilla es solo sobre si se ven o no.

  Si la sincronización falla (por ejemplo, el sitio de la Iglesia no responde), las actividades de Estaca ya guardadas se mantienen intactas — nunca desaparecen ni dejan de aplicar sus reglas por una falla pasajera de red. *(En el demo de un solo archivo esto se simula con actividades de ejemplo ya "sincronizadas" y sin conexión real a internet.)*
- **Perfiles / roles**:
  - **Administrador**: ve y edita todo, y además gestiona los perfiles (usuarios) y las organizaciones.
  - **Líder**: ve todo el calendario, y puede crear/editar/eliminar tanto actividades como entrevistas de su propia organización (las entrevistas solo aplican si su organización es Obispado, Cuórum de Élderes o Sociedad de Socorro). Ve el Presupuesto asignado a su organización y registra sus propios gastos; el líder de Obispado además asigna el presupuesto de todas las organizaciones.
  - **Miembro**: solo puede consultar el calendario, sin editar nada, sin ver la sección de Entrevistas y sin ver el módulo de Presupuesto.
- **Autorregistro con aprobación del administrador**: en vez de que el administrador tenga que crear manualmente los 100+ usuarios del barrio, cualquier persona puede pedir su propia cuenta desde la pantalla de ingreso ("¿No tienes cuenta? Solicita una aquí"), eligiendo su nombre, su usuario, su contraseña y el perfil que cree que le corresponde (Miembro, o Líder de una organización). La cuenta queda **pendiente** — no puede ingresar todavía — hasta que un administrador la revisa en Administración → Solicitudes y la aprueba (pudiendo corregir el perfil u organización si la persona se equivocó) o la rechaza. Así el trabajo del administrador se reduce a aprobar con un clic en vez de tipear cada cuenta a mano.

## Tecnología

Este proyecto se construyó **sin dependencias externas**: el backend usa únicamente el runtime estándar de Node.js (`http`, `crypto`, `fs`) y el frontend es HTML/CSS/JavaScript puro, sin frameworks ni paso de compilación. Esto lo hace muy liviano y fácil de desplegar en cualquier lugar que corra Node 18+, sin `npm install` y sin sorpresas de versiones de paquetes.

- `server/` — API REST (autenticación, organizaciones, eventos, entrevistas, usuarios, presupuesto, calendario de Estaca) y guarda los datos en `server/data/db.json`.
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

| Rol | Usuario | Contraseña |
|---|---|---|
| Administrador | admin@ward.local | admin123 |
| Líder (uno por organización; en Obispado, Cuórum de Élderes y Sociedad de Socorro también agenda entrevistas) | lider.obispado@ward.local, lider.primaria@ward.local, etc. | lider123 |
| Miembro | miembro@ward.local | miembro123 |

> Nota: el campo "Usuario" **no necesita ser un correo real** — es solo un nombre único para ingresar (puede ser `primaria.presidenta`, `juan.perez`, lo que prefieras). Los de la tabla de ejemplo tienen forma de email por costumbre, pero no reciben ni envían nada.

**Importante:** cambia estas contraseñas (o crea usuarios nuevos y elimina estos) antes de usar la app con datos reales, desde el panel de Administración → Usuarios.

## Cómo desplegarlo para que todos lo usen desde su celular

Ver el archivo **`GUIA-DESPLIEGUE.md`** en la raíz del proyecto: tiene el paso a paso completo (GitHub → Render, disco persistente, variables de entorno, creación de usuarios reales) explicado para alguien que no programa.

En resumen, lo único que de verdad importa es: (1) que el proceso de Node se mantenga corriendo 24/7 (por eso se recomienda el plan Starter de Render y no el gratuito, que se apaga solo), y (2) que los datos se guarden en un disco persistente y no se borren en cada despliegue (por eso se configura la variable `DB_PATH` apuntando al disco).

## Notificaciones automáticas de entrevistas (por email, con tu Gmail)

Ya está implementado, y llega a **los dos participantes** (al líder que realiza la entrevista y al miembro que asiste), a cada uno que tenga su email cargado en la entrevista:

- **Recordatorio**: el servidor revisa cada 15 minutos qué entrevistas empiezan en ~24 horas y envía un correo con los datos (miembro, líder, fecha, hora, lugar, detalle). Cada entrevista dispara **un solo** recordatorio (no se repite).
- **Cancelación**: si se elimina la entrevista, se envía de inmediato un correo avisando que fue cancelada, con los datos que tenía.
- **Cambio de fecha/horario**: si se edita el día o la hora de una entrevista ya agendada, se envía de inmediato un correo mostrando el horario anterior y el nuevo. (Si además cambia el email de contacto de alguno de los dos, el recordatorio de 24 horas vuelve a habilitarse para la nueva fecha.)

Se eligió enviar los correos **desde tu propia cuenta de Gmail** (en vez de un servicio externo tipo Resend) porque no requiere tener un dominio propio ni crear cuenta en nada nuevo — solo tu Gmail, gratis, y una "contraseña de aplicación". WhatsApp queda descartado por ahora: requiere verificación de negocio con Meta, un número dedicado y plantillas pre-aprobadas, lo que toma días.

**Para activarlo, solo te falta hacer esto (una sola vez):**

1. Recomendado: crea una cuenta de Gmail nueva y dedicada solo para esto (ej. `calendariobarriovallegrande@gmail.com`) en vez de usar tu Gmail personal — así no se mezcla con tu correo y cualquier futuro administrador puede seguir usándola. Es gratis y toma 2 minutos en [accounts.google.com/signup](https://accounts.google.com/signup).
2. En esa cuenta, activa la verificación en dos pasos: **Cuenta de Google → Seguridad → Verificación en 2 pasos** (obligatorio para poder crear una contraseña de aplicación).
3. Luego ve a **Cuenta de Google → Seguridad → Contraseñas de aplicaciones** (o busca "contraseñas de aplicación" en la barra de búsqueda de la configuración). Crea una nueva, ponle un nombre como "Calendario Barrio" y copia el código de 16 letras que te da (sin espacios).
4. En Render, ve a tu servicio → **Environment** y agrega estas dos variables:
   - `GMAIL_USER` = la cuenta completa, ej. `calendariobarriovallegrande@gmail.com`.
   - `GMAIL_APP_PASSWORD` = el código de 16 letras del paso anterior.
5. Guarda — Render reinicia el servicio solo. Desde ese momento, toda entrevista con el email del líder y/o del miembro cargado va a recibir sus notificaciones automáticamente, enviadas desde esa cuenta de Gmail.

Gmail permite hasta 500 correos por día en una cuenta normal, muy por sobre lo que necesita un barrio. Si no configuras estas variables, la app sigue funcionando normal — simplemente las notificaciones quedan desactivadas (se ve un aviso en los logs del servidor, sin errores para los usuarios).

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
