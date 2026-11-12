import { useQuery } from "@tanstack/react-query";
import { queries } from "./queries";

export const blockedBy = (count: number) => `New sends are blocked by ${count} unresolved operation${count === 1 ? "" : "s"}.`;

/**
 * Why Execute and Shield are not offered: only the latest unresolved read, when it succeeded and reports operations.
 * A failed or pending read leaves the controls as they were. Either way the server's refusal stays the authority.
 */
export function useSendBlock() {
  const unresolved = useQuery(queries.unresolved);
  return unresolved.status === "success" && unresolved.data.length ? `${blockedBy(unresolved.data.length)} Preview is still available.` : undefined;
}
