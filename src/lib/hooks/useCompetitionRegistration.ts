import { useCallback, useState } from "react";
import freighterApi from "@stellar/freighter-api";
import {
  registerForCompetition,
  requestRegistrationMessage,
  setCompetitionDisplayName,
} from "../api/competitions";
import type { CompetitionRegistration } from "../api/types";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Registration failed";
}

/** Sign the backend's challenge with Freighter. Overridable so tests do not need an extension. */
export type CompetitionSigner = (message: string) => Promise<string>;

const freighterSigner: CompetitionSigner = (message) => freighterApi.signBlob(message);

export interface UseCompetitionRegistrationOptions {
  competitionId: string;
  address: string | null;
  token: string | null;
  sign?: CompetitionSigner;
  onRegistered?: (registration: CompetitionRegistration) => void;
}

/**
 * Competition opt-in (issue #93).
 *
 * Opt-in is a signed message, not a bearer-token POST: the wallet signs a
 * backend-issued challenge that names the competition, and the backend proves
 * the signature came from the address being entered. A bearer token alone
 * would let a stolen session enter an address the holder does not control —
 * the same reasoning as the sign-in flow in `store/wallet.ts`.
 *
 * The signing step is injectable so the flow is testable without a Freighter
 * extension (there isn't one in CI, and there wasn't one in the environment
 * this was built in either).
 */
export function useCompetitionRegistration({
  competitionId,
  address,
  token,
  sign = freighterSigner,
  onRegistered,
}: UseCompetitionRegistrationOptions) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<CompetitionRegistration | null>(null);

  const register = useCallback(
    async (displayName?: string | null): Promise<CompetitionRegistration | null> => {
      if (!address) {
        setError("Connect a wallet before entering a competition.");
        return null;
      }
      setSubmitting(true);
      setError(null);
      try {
        const { message } = await requestRegistrationMessage(competitionId, address);
        const signature = await sign(message);
        const result = await registerForCompetition({
          competitionId,
          walletAddress: address,
          message,
          signature,
          displayName,
          token,
        });
        setRegistration(result);
        onRegistered?.(result);
        return result;
      } catch (err) {
        setError(messageOf(err));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [address, competitionId, onRegistered, sign, token]
  );

  const updateDisplayName = useCallback(
    async (displayName: string): Promise<CompetitionRegistration | null> => {
      if (!token) {
        setError("Connect a wallet before changing your display name.");
        return null;
      }
      setSubmitting(true);
      setError(null);
      try {
        const result = await setCompetitionDisplayName(competitionId, displayName, token);
        setRegistration(result);
        return result;
      } catch (err) {
        setError(messageOf(err));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [competitionId, token]
  );

  return { register, updateDisplayName, submitting, error, registration, setError };
}
