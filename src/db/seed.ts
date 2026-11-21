import { logger } from "../config/logger";
import { sincronizarTenants } from "../tenants/loader";
import { prisma } from "./prisma";

// Carga en la base de datos todos los tenants definidos en src/tenants/<id>/.
async function main(): Promise<void> {
  const ids = await sincronizarTenants();
  logger.info({ tenants: ids }, "Seed completado");
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Seed falló");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
