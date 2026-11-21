-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "ownerWhatsapp" TEXT,
    "zonaHoraria" TEXT NOT NULL DEFAULT 'America/Bogota',
    "catalogoJson" TEXT,
    "menuJson" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversacion" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "nombreCliente" TEXT,
    "datosCliente" TEXT NOT NULL DEFAULT '{}',
    "resumen" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'ACTIVA',
    "ultimoEntranteEn" TIMESTAMP(3),
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mensaje" (
    "id" SERIAL NOT NULL,
    "conversacionId" INTEGER NOT NULL,
    "rol" TEXT NOT NULL,
    "contenido" TEXT NOT NULL,
    "waMessageId" TEXT,
    "resumido" BOOLEAN NOT NULL DEFAULT false,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mensaje_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reserva" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversacionId" INTEGER,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "experienciaId" TEXT NOT NULL,
    "experienciaNombre" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "profInicio" TIMESTAMP(3),
    "profFin" TIMESTAMP(3),
    "habitacionId" TEXT,
    "personas" INTEGER NOT NULL,
    "noches" INTEGER NOT NULL DEFAULT 0,
    "totalEstimado" INTEGER,
    "depositoEstimado" INTEGER,
    "notas" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reserva_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recordatorio" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "fechaHora" TIMESTAMP(3) NOT NULL,
    "mensaje" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "reservaId" INTEGER,
    "enviadoEn" TIMESTAMP(3),
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recordatorio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notificacion" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "resumen" TEXT NOT NULL,
    "telefonoCliente" TEXT,
    "enviada" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notificacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_phoneNumberId_key" ON "Tenant"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversacion_tenantId_telefono_key" ON "Conversacion"("tenantId", "telefono");

-- CreateIndex
CREATE UNIQUE INDEX "Mensaje_waMessageId_key" ON "Mensaje"("waMessageId");

-- CreateIndex
CREATE INDEX "Mensaje_conversacionId_id_idx" ON "Mensaje"("conversacionId", "id");

-- CreateIndex
CREATE INDEX "Reserva_tenantId_estado_profInicio_idx" ON "Reserva"("tenantId", "estado", "profInicio");

-- CreateIndex
CREATE INDEX "Reserva_tenantId_estado_inicio_idx" ON "Reserva"("tenantId", "estado", "inicio");

-- CreateIndex
CREATE INDEX "Recordatorio_estado_fechaHora_idx" ON "Recordatorio"("estado", "fechaHora");

-- AddForeignKey
ALTER TABLE "Conversacion" ADD CONSTRAINT "Conversacion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mensaje" ADD CONSTRAINT "Mensaje_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reserva" ADD CONSTRAINT "Reserva_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reserva" ADD CONSTRAINT "Reserva_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recordatorio" ADD CONSTRAINT "Recordatorio_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recordatorio" ADD CONSTRAINT "Recordatorio_reservaId_fkey" FOREIGN KEY ("reservaId") REFERENCES "Reserva"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notificacion" ADD CONSTRAINT "Notificacion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
