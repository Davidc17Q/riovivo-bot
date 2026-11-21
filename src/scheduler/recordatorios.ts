import { logger } from "../config/logger";
import { procesarRecordatoriosPendientes } from "../services/recordatorios";

const INTERVALO_MS = 60_000;

/**
 * Scheduler simple sobre la base de datos: cada minuto envía los recordatorios
 * vencidos. Los jobs viven en la tabla Recordatorio, así que sobreviven a reinicios.
 */
export function iniciarSchedulerRecordatorios(): () => void {
  let enCurso = false;

  const tick = async (): Promise<void> => {
    if (enCurso) return; // evita solapar ejecuciones si una tarda más de un minuto
    enCurso = true;
    try {
      const enviados = await procesarRecordatoriosPendientes();
      if (enviados > 0) logger.info({ enviados }, "Recordatorios enviados");
    } catch (error) {
      logger.error({ err: error }, "Error en el scheduler de recordatorios");
    } finally {
      enCurso = false;
    }
  };

  const temporizador = setInterval(() => void tick(), INTERVALO_MS);
  temporizador.unref();
  void tick();
  return () => clearInterval(temporizador);
}
