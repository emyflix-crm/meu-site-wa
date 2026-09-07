FROM node:20-alpine

WORKDIR /app

# Instala dependências
COPY package*.json ./
RUN npm ci --only=production

# Copia código fonte
COPY . .

# Cria diretórios necessários
RUN mkdir -p /app/data /app/data/uploads /app/data/logs public/uploads

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

CMD ["node", "server.js"]
