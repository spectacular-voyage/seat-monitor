import { isIPv4 } from "node:net";

import { z } from "zod";

export const serverHostSchema = z.enum(["127.0.0.1", "localhost", "0.0.0.0"]);

export const allowedHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (host) =>
      host !== "0.0.0.0" &&
      (isIPv4(host) ||
        (!/^[\d.]+$/u.test(host) &&
          host
            .split(".")
            .every((label) =>
              /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(label),
            ))),
    "Allowed hosts must be IPv4 addresses or hostnames, without ports or wildcards.",
  )
  .transform((host) => host.toLowerCase());

export const serverNetworkSchema = z
  .object({
    host: serverHostSchema,
    allowedHosts: z.array(allowedHostSchema),
  })
  .refine(
    (network) => network.host !== "0.0.0.0" || network.allowedHosts.length > 0,
    "LAN listening requires at least one allowed host.",
  );
