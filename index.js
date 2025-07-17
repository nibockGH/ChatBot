// ------------------------------------------------------------------
// 1. CONFIGURACIÓN INICIAL
// ------------------------------------------------------------------
require('dotenv').config(); // Carga las variables de entorno desde el archivo .env

const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PENDING_FILE_PATH = path.join(__dirname, 'pending.json');
console.log(`Ruta del archivo de pendientes: ${PENDING_FILE_PATH}`);

// --- Credenciales y IDs (Leídos desde Variables de Entorno) ---
const CALENDAR_ID = process.env.CALENDAR_ID;
const APPOINTMENT_DURATION = 30;

// --- Configuración de Twilio (Leídos desde Variables de Entorno) ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
const DOCTOR_WHATSAPP_NUMBER = process.env.DOCTOR_WHATSAPP_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Autenticación con Google ---
const auth = new google.auth.GoogleAuth({
  keyFile: './credentials.json',
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// ------------------------------------------------------------------
// 2. FUNCIONES AUXILIARES PARA PERSISTENCIA
// ------------------------------------------------------------------

function readPendingAppointments() {
    console.log('--- Intentando leer el archivo de pendientes ---');
    try {
        if (fs.existsSync(PENDING_FILE_PATH)) {
            const data = fs.readFileSync(PENDING_FILE_PATH, 'utf8');
            console.log('Archivo pending.json encontrado. Contenido:', data);
            if (data.trim() === '') return {};
            return JSON.parse(data);
        } else {
            console.log('ADVERTENCIA: El archivo pending.json no existe.');
            return {};
        }
    } catch (error) {
        console.error('ERROR CRÍTICO al leer o parsear pending.json:', error);
        return {};
    }
}

function writePendingAppointments(data) {
    console.log('--- Intentando escribir en el archivo de pendientes ---');
    try {
        fs.writeFileSync(PENDING_FILE_PATH, JSON.stringify(data, null, 2));
        console.log('Escritura en pending.json exitosa. Contenido guardado:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('ERROR CRÍTICO al escribir en pending.json:', error);
    }
}

// ------------------------------------------------------------------
// 3. LÓGICA DEL CALENDARIO Y NOTIFICACIONES
// ------------------------------------------------------------------

async function findFreeSlots(date, durationMinutes, timePreference) {
    console.log(`Buscando huecos de ${durationMinutes} min para el día ${date} por la ${timePreference}`);
    let startOfDay, endOfDay;
    if (timePreference.toLowerCase() === 'mañana') {
        startOfDay = new Date(`${date}T09:00:00-03:00`);
        endOfDay = new Date(`${date}T13:00:00-03:00`);
    } else {
        startOfDay = new Date(`${date}T14:00:00-03:00`);
        endOfDay = new Date(`${date}T19:00:00-03:00`);
    }

    try {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(), singleEvents: true, orderBy: 'startTime',
        });
        const busySlots = response.data.items;
        const potentialSlots = [];
        let currentTime = new Date(startOfDay);
        while (currentTime < endOfDay) {
            potentialSlots.push(new Date(currentTime));
            currentTime.setMinutes(currentTime.getMinutes() + durationMinutes);
        }
        const availableSlots = potentialSlots.filter(slot => {
            const slotStart = slot.getTime();
            const slotEnd = slotStart + durationMinutes * 60 * 1000;
            return !busySlots.some(event => {
                if (event.start.dateTime) {
                    const eventStart = new Date(event.start.dateTime).getTime();
                    const eventEnd = new Date(event.end.dateTime).getTime();
                    return (slotStart < eventEnd) && (slotEnd > eventStart);
                }
                return true;
            });
        });
        const formattedSlots = availableSlots.map(slot => slot.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }));
        console.log('Horarios libres encontrados:', formattedSlots);
        return formattedSlots;
    } catch (error) {
        console.error('Error al conectar con Google Calendar API:', error);
        return [];
    }
}

async function createCalendarEvent(dateTime, patientName, reason, customId) {
  console.log(`Creando evento para: ${patientName} con ID: ${customId}`);
  const eventStartTime = new Date(dateTime);
  const eventEndTime = new Date(eventStartTime.getTime() + APPOINTMENT_DURATION * 60 * 1000);
  try {
    const newEvent = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `(PENDIENTE-${customId}) Turno para ${patientName}`,
        description: `Motivo: ${reason}\nID de Turno: ${customId}`,
        start: { dateTime: eventStartTime.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
        end: { dateTime: eventEndTime.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
      },
    });
    console.log('Evento creado con éxito.');
    return newEvent.data.id;
  } catch (error) {
    console.error('Error al crear el evento en Google Calendar:', error);
    return null;
  }
}

async function sendConfirmationToDoctor(patientName, date, time, reason, customId) {
    const messageBody = `NUEVA SOLICITUD DE TURNO 🔵\n\nPaciente: ${patientName}\nFecha: ${date}\nHora: ${time}\nMotivo: ${reason}\n\nPara confirmar, responde: CONFIRMAR ${customId}\nPara rechazar, responde: RECHAZAR ${customId}`;
    try {
        await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to: DOCTOR_WHATSAPP_NUMBER, body: messageBody });
        console.log('Mensaje de confirmación enviado al doctor.');
    } catch (error) {
        console.error('Error al enviar el mensaje de Twilio:', error);
    }
}

// ------------------------------------------------------------------
// 4. WEBHOOK PRINCIPAL (PARA DIALOGFLOW)
// ------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
    const intentName = req.body.queryResult.intent.displayName;
    console.log(`\n>>> INTENT RECIBIDO: ${intentName}`);

    if (intentName === 'Solicitar_Turno') {
      // ---- CAMBIO IMPORTANTE ----
      // Ahora, este intent solo hace la pregunta sobre ortodoncia.
      const response = {
        fulfillmentText: '¡Claro! Para darte el turno correcto, primero decime, ¿la consulta es para Ortodoncia u Ortopedia?',
        // Este formato de "fulfillmentMessages" es opcional pero ayuda a mostrar botones
        // en algunas plataformas como el propio chat de Dialogflow.
        fulfillmentMessages: [
          {
            "platform": "ACTIONS_ON_GOOGLE", // Plataforma genérica que suele funcionar
            "suggestions": {
              "suggestions": [
                { "title": "Sí, para ortodoncia" },
                { "title": "No, es para otra cosa" }
              ]
            }
          }
        ]
      };
      return res.json(response);
    } 
    else if (intentName === 'Solicitar_Turno - select_time') { // Dejamos esta lógica por si la reutilizamos
      try {
        if (!req.body.queryResult.outputContexts || req.body.queryResult.outputContexts.length === 0) {
          return res.json({ fulfillmentText: 'Me perdí en la conversación, ¿podríamos empezar de nuevo?' });
        }
        const contextParams = req.body.queryResult.outputContexts[0].parameters;
        const patientName = contextParams.patient_name.name || contextParams['patient_name.original'];
        const reason = contextParams.consultation_reason || contextParams['consultation_reason.original'];
        const turnDate = contextParams.turn_date;
        const selectedTime = req.body.queryResult.parameters.time;
        if(!patientName || !reason || !turnDate || !selectedTime) {
            return res.json({ fulfillmentText: 'Faltó información para agendar. ¿Empezamos de nuevo?' });
        }
        const eventDateTime = new Date(turnDate);
        const timeStr = new Date(selectedTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
        const [hours, minutes] = timeStr.split(':');
        eventDateTime.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
        const customId = `T-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const googleEventId = await createCalendarEvent(eventDateTime, patientName, reason, customId);

        if (googleEventId) {
          const pendingAppointments = readPendingAppointments();
          pendingAppointments[customId] = googleEventId;
          writePendingAppointments(pendingAppointments);
          
          const friendlyDate = eventDateTime.toLocaleDateString('es-AR');
          await sendConfirmationToDoctor(patientName, friendlyDate, timeStr, reason, customId);
          res.json({ fulfillmentText: `¡Excelente! Se envió la solicitud al doctor para su confirmación final.` });
        } else {
          res.json({ fulfillmentText: 'Hubo un problema al crear la cita en el calendario. Intenta de nuevo.' });
        }
      } catch (error) {
        console.error('[SELECT_TIME] ¡CRASH INESPERADO!', error);
        res.json({ fulfillmentText: 'Ups, ocurrió un error técnico al procesar la hora.' });
      }
    }
    else {
      res.json({ fulfillmentText: 'Disculpa, no entendí qué necesitas.' });
    }
});

// ------------------------------------------------------------------
// 5. WEBHOOK SECUNDARIO (PARA RESPUESTAS DE TWILIO)
// ------------------------------------------------------------------
app.post('/twilio-reply', async (req, res) => {
    console.log('\n\n\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('!!!       WEBHOOK DE TWILIO ACTIVADO           !!!');
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    
    const from = req.body.From;
    const messageBody = req.body.Body.trim().toUpperCase();
    console.log(`Respuesta del doctor recibida: "${messageBody}" de ${from}`);

    if (from === DOCTOR_WHATSAPP_NUMBER) {
        const parts = messageBody.split(' ');
        if (parts.length === 2) {
            const action = parts[0];
            const customId = parts[1];
            console.log(`Acción detectada: '${action}', ID detectado: '${customId}'`);

            const pendingAppointments = readPendingAppointments();
            console.log('Contenido de pendientes LEÍDO dentro de /twilio-reply:', pendingAppointments);
            
            const googleEventId = pendingAppointments[customId];

            if (googleEventId) {
                console.log(`ÉXITO: Se encontró el ID de Google '${googleEventId}' para el ID personalizado '${customId}'.`);
                try {
                    if (action === 'CONFIRMAR') {
                        const eventToUpdate = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: googleEventId });
                        const newTitle = eventToUpdate.data.summary.replace(`(PENDIENTE-${customId})`, 'Turno Confirmado ✅');
                        
                        await calendar.events.patch({
                            calendarId: CALENDAR_ID,
                            eventId: googleEventId,
                            requestBody: { summary: newTitle },
                        });
                        console.log(`El turno ${customId} ha sido ACTUALIZADO a: ${action}`);

                    } else if (action === 'RECHAZAR') {
                        await calendar.events.delete({
                            calendarId: CALENDAR_ID,
                            eventId: googleEventId,
                        });
                        console.log(`El turno ${customId} ha sido RECHAZADO y ELIMINADO.`);
                        await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to: DOCTOR_WHATSAPP_NUMBER, body: `El turno ${customId} fue rechazado y eliminado del calendario.` });
                    }
                    
                    delete pendingAppointments[customId];
                    writePendingAppointments(pendingAppointments);
                } catch (error) {
                    console.error("Error al procesar la respuesta del doctor (get/patch/delete):", error);
                    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to: DOCTOR_WHATSAPP_NUMBER, body: `Hubo un error al procesar el turno ${customId}. Es posible que ya haya sido eliminado.` });
                }

            } else {
                console.log(`FALLO: No se encontró un turno pendiente con el ID '${customId}' en el objeto leído del archivo.`);
                await twilioClient.messages.create({
                    from: TWILIO_WHATSAPP_NUMBER,
                    to: DOCTOR_WHATSAPP_NUMBER,
                    body: `No se encontró un turno pendiente con el ID ${customId}. Puede que ya haya sido procesado o que el ID sea incorrecto.`,
                });
            }
        } else {
            console.log(`El mensaje del doctor no tiene el formato esperado (ACCIÓN ID). Mensaje: "${messageBody}"`);
        }
    } else {
        console.log(`Mensaje ignorado. Vino de ${from} en lugar del doctor ${DOCTOR_WHATSAPP_NUMBER}`);
    }
    res.status(204).send();
});


// ------------------------------------------------------------------
// 6. INICIAR SERVIDOR
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log('¡El cerebro del bot está en marcha!');
});