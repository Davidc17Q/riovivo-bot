import Fastify, { type FastifyBaseLogger } from "fastify";
import { registrarAdmin } from "./admin/rutas";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./db/prisma";
import { iniciarSchedulerRecordatorios } from "./scheduler/recordatorios";
import { sincronizarTenants } from "./tenants/loader";
import { registrarTestChat } from "./whatsapp/testChat";
import { registrarWebhook } from "./whatsapp/webhook";

declare module "fastify" {
  interface FastifyRequest {
    /** Cuerpo sin parsear: necesario para validar la firma de Meta. */
    rawBody?: Buffer;
  }
}

async function main(): Promise<void> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: 1_048_576,
    // El log por defecto incluye la URL completa, y la verificación de Meta trae
    // el verify token en la query. Se registra solo método, ruta y estado.
    disableRequestLogging: true,
  });
  app.addHook("onResponse", async (req, reply) => {
    const ruta = req.url.split("?")[0];
    if (ruta !== "/health") logger.info({ metodo: req.method, ruta, estado: reply.statusCode }, "Petición atendida");
  });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, cuerpo, done) => {
    const buffer = cuerpo as Buffer;
    req.rawBody = buffer;
    try {
      done(null, buffer.length > 0 ? JSON.parse(buffer.toString("utf8")) : {});
    } catch {
      const error = new Error("JSON inválido") as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));
  registrarWebhook(app);
  registrarAdmin(app);
  if (env.testChatHabilitado) registrarTestChat(app);

  const tenants = await sincronizarTenants();
  if (!env.ANTHROPIC_API_KEY) logger.warn("Falta ANTHROPIC_API_KEY: el bot responderá el mensaje de respaldo");
  if (!env.WHATSAPP_VERIFY_TOKEN) logger.warn("Falta WHATSAPP_VERIFY_TOKEN: Meta no podrá verificar el webhook");
  if (env.esProduccion && !env.WHATSAPP_APP_SECRET) {
    logger.warn("Falta WHATSAPP_APP_SECRET: el webhook no valida la firma de Meta");
  }

  const detenerScheduler = iniciarSchedulerRecordatorios();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ tenants, modelo: env.ANTHROPIC_MODEL, testChat: env.testChatHabilitado }, "Asistente listo");

  const apagar = async (): Promise<void> => {
    detenerScheduler();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void apagar());
  process.once("SIGTERM", () => void apagar());
}

// Una promesa rechazada en segundo plano no debe tumbar el servidor.
process.on("unhandledRejection", (razon) => logger.error({ err: razon }, "Promesa rechazada sin manejar"));

main().catch((error: unknown) => {
  logger.error({ err: error }, "No se pudo iniciar el servidor");
  process.exit(1);
});
