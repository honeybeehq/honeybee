/** Versioned admission token shared by the core and deploy owner. */
export const UPDATE_RECOVERY_CONTRACT = "honeybee-v27-disabled-authority-v1";
export type UpdateReservation = { epoch: number; id: string; recoverySubjectDigest: string; active: boolean };

export function parseUpdateReservation(value: unknown): UpdateReservation {
  const r = value as Partial<UpdateReservation> | null;
  if (!r || !Number.isSafeInteger(r.epoch) || r.epoch! < 1 || typeof r.active !== "boolean"
    || typeof r.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(r.id)
    || typeof r.recoverySubjectDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(r.recoverySubjectDigest)) {
    throw new Error("Corrupt coordinated update reservation; recovery required");
  }
  return { epoch: r.epoch!, id: r.id, recoverySubjectDigest: r.recoverySubjectDigest, active: r.active };
}

