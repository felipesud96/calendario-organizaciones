# Imagen de producción de OrganizaSion, con soporte de OCR para la carga
# asistida de PDF en "Crecimiento del Barrio".
#
# El servidor no usa librerías npm de terceros (ver server/package.json),
# pero la lectura de PDF sí necesita dos programas del sistema operativo
# que Render NO instala en su entorno "Node nativo": poppler-utils
# (pdftoppm/pdfinfo, para convertir cada página del PDF en una imagen) y
# tesseract-ocr (para leer el texto de esa imagen). Por eso este proyecto
# se despliega como servicio Docker en vez de Node nativo — es la única
# forma de instalar esos dos paquetes en el servidor.
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
COPY . .

WORKDIR /app/server
EXPOSE 4000
CMD ["node", "src/server.js"]
