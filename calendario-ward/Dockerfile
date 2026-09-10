# Imagen de producción de OrganizaSion, con soporte de OCR para la carga
# asistida de PDF en "Crecimiento del Barrio".
#
# La lectura de PDF necesita dos programas del sistema operativo que Render
# NO instala en su entorno "Node nativo": poppler-utils (pdftoppm/pdfinfo,
# para convertir cada página del PDF en una imagen) y tesseract-ocr (para
# leer el texto de esa imagen). Por eso este proyecto se despliega como
# servicio Docker en vez de Node nativo — es la única forma de instalar
# esos dos paquetes en el servidor.
FROM node:20-slim

# tesseract-ocr-spa: paquete de idioma español, para que los nombres con
# tildes/ñ de la tabla de conversos se lean bien (los números no dependen
# del idioma, así que aunque este paquete faltara igual funcionaría, solo
# con más errores de tilde en los nombres).
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-spa \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# El servidor usaba cero librerías npm de terceros hasta que se agregó
# web-push (notificaciones push del navegador, ver server/package.json) —
# hasta entonces esta imagen nunca había necesitado un paso de instalación,
# por eso no existía. Se copia primero SOLO el package.json (en vez de
# depender del "COPY . ." de más abajo) para que Docker pueda reusar esta
# capa entre builds mientras no cambien las dependencias, en vez de repetir
# el "npm install" cada vez que cambia cualquier archivo del proyecto.
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

COPY . .

WORKDIR /app/server
EXPOSE 4000
CMD ["node", "src/server.js"]
