import { sha256Hex, validateMedia } from '../database/mediaStore.js';

// Online-only actions of the operational modules, on the existing FastAPI endpoints.
//
// Captures that the sync protocol supports (POST /sync/batch: attendance, inspection, passenger start,
// railway feedback, complaint, inventory) go through operationsQueue.submit and work offline. Everything
// here needs the server: a server-assigned identifier, a record version check, an external
// verification (PNR/OTP) or a state change /sync/batch has no operation for. `api` is the local-first
// API, which refuses these writes offline with `offline_action` and changes nothing locally until the
// server confirms. ONLINE_ONLY gives the reason the screens show while offline.
export const ONLINE_ONLY = {
  journey: 'Journeys get their identifiers and versions from the server, so they can only be changed online.',
  staff: 'Staff allocation is checked by the server against other journeys, so it needs a connection.',
  review: 'Verification is recorded by the server, so it needs a connection.',
  pnr: 'PNR and OTP verification are checked by the server against external services.',
  feedback: 'This feedback step is recorded by the server, so it needs a connection.',
  complaint: 'Complaint status changes are recorded by the server, so they need a connection.',
};

export const isVersionConflict = (e) => e?.status === 409 && e?.code === 'version_conflict';

const review = (status, remarks) => ({ status, remarks: remarks?.trim() || null });

export function createOperations(api) {
  return {
    journeys: {
      create: (body) => api.post('/journeys', body),
      update: (j, changes) => api.patch(`/journeys/${j.id}`, { version: j.version, ...changes }),
      // backend CoachIn: { code, classification }; order is the list order
      setCoaches: (j, coaches) => api.patch(`/journeys/${j.id}`, {
        version: j.version, coaches: coaches.map(({ code, classification }) => ({ code, classification })),
      }),
      cancel: (j, reason) => api.post(`/journeys/${j.id}/cancel`, { version: j.version, reason }),
      assignSupervisor: (j, supervisorId) => api.post(`/journeys/${j.id}/supervisor`, { version: j.version, supervisor_id: supervisorId }),
      addStaff: (j, userIds) => api.post(`/staff-allocation/${j.id}`, { user_ids: userIds }),
      removeStaff: (j, userId) => api.del(`/staff-allocation/${j.id}/${userId}`),
    },
    attendance: {
      review: (id, status, remarks) => api.post(`/attendance/${id}/review`, review(status, remarks)),
    },
    inspections: {
      review: (id, status, remarks) => api.post(`/inspections/${id}/review`, review(status, remarks)),
    },
    passengerFeedback: {
      verifyPnr: (id) => api.post(`/feedback/passenger/${id}/verify-pnr`),
      sendOtp: (id) => api.post(`/feedback/passenger/${id}/send-otp`),
      verifyOtp: (id, code) => api.post(`/feedback/passenger/${id}/verify-otp`, { code }),
      complete: (id, ratings, comments, voiceMediaId = null) => api.post(`/feedback/passenger/${id}/complete`, {
        ratings: Object.entries(ratings).map(([question_id, value]) => ({ question_id, value })), comments: comments?.trim() || null,
        ...(voiceMediaId ? { voice_media_id: voiceMediaId } : {}),
      }),
      void: (id, reason) => api.post(`/feedback/passenger/${id}/void`, { reason: reason.trim() }),
    },
    railwayFeedback: {
      review: (id, status, remarks) => api.post(`/feedback/railway/${id}/review`, review(status, remarks)),
    },
    // Direct upload (POST /media + PUT content, the protocol operationsQueue uses) for media that belongs to
    // an online-only step. `value`: a Capture.jsx video/voice value. Returns the media id once uploaded.
    media: {
      async upload({ value, kind, divisionId }) {
        const id = crypto.randomUUID();
        validateMedia({ kind, mimeType: value.mimeType, size: value.size });
        const bytes = new Uint8Array(await value.blob.arrayBuffer());
        await api.post('/media', { id, division_id: divisionId, kind, content_type: value.mimeType, size_bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
        await api.putRaw(`/media/${id}/content`, bytes, value.mimeType);
        return id;
      },
    },
    complaints: {
      transition: (id, { to, remarks, departmentId, forwardTo }) => api.post(`/complaints/${id}/transition`, {
        to_status: to, remarks: remarks?.trim() || null, department_id: departmentId || null, forward_to_user_id: forwardTo || null,
      }),
    },
  };
}
