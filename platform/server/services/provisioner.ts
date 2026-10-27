import { randomBytes } from "node:crypto";
import { HetznerCloudClient } from "./hetzner-cloud.js";
import { errorMessage, logEvent } from "../lib/log.js";

const PLAN_CONFIGS = {
  starter: { storage_gb: 10 },
  pro: { storage_gb: 50 },
  enterprise: { storage_gb: 100 },
} as const;

export type Plan = keyof typeof PLAN_CONFIGS;
export type ProvisionProgressFn = (step: string, label: string, status: "in_progress" | "done" | "error") => void;

/** Label key/values stamped on every Hetzner resource the platform creates. */
export const RESOURCE_LABELS = {
  app: "companion",
  managedBy: "companion-cloud",
} as const;
export const INSTANCE_LABEL = "instance";

/**
 * One-time bootstrap credentials placed in cloud-init user_data instead of
 * the instance's long-lived secrets. The instance POSTs `token` to `url` once
 * at first boot and receives its env secrets (COMPANION_AUTH_TOKEN, ...).
 */
export interface BootstrapCredentials {
  url: string;
  token: string;
}

interface ProvisionInput {
  organizationId: string;
  plan: Plan;
  region: string;
  hostname: string;
  loginUrl: string;
  /** DB row id; stamped on Hetzner resources as the `instance` label for the orphan reconciler. */
  instanceId?: string;
  /** Required: how the instance fetches its secrets. No long-lived secret is ever put in user_data. */
  bootstrap?: BootstrapCredentials;
  /**
   * @deprecated Ignored. A Tailscale auth key is a long-lived secret and is no
   * longer embedded in cloud-init user_data; deliver it via the bootstrap
   * exchange (server/routes/bootstrap.ts) when Tailscale enablement is built.
   */
  tailscaleAuthKey?: string;
  onProgress?: ProvisionProgressFn;
}

interface ProvisionResult {
  providerMachineId: string;
  providerVolumeId: string;
  hostname: string;
}

interface ProvisionerConfig {
  hetznerToken: string;
  companionImage: string;
  hetznerSshKeyId?: string;
  hetznerServerTypes?: Partial<Record<Plan, string>>;
}

const DEFAULT_SERVER_TYPE_CANDIDATES: Record<Plan, string[]> = {
  starter: ["cpx11", "cpx22", "cx23"],
  pro: ["cpx21", "cpx32", "cx33"],
  enterprise: ["cpx31", "cpx42", "cx43"],
};

const EUROPE_SERVER_TYPE_CANDIDATES: Record<Plan, string[]> = {
  starter: ["cpx22", "cx23", "cpx11"],
  pro: ["cpx32", "cx33", "cpx21"],
  enterprise: ["cpx42", "cx43", "cpx31"],
};

function makeVolumeName(hostname: string, suffixSeed: string): string {
  const safe = hostname
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = (safe || "instance").slice(0, 20);
  return `companion_${suffix}_${suffixSeed}`;
}

function makeMachineName(hostname: string, suffixSeed: string): string {
  const safe = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = (safe || "instance").slice(0, 32);
  return `companion-${suffix}-${suffixSeed}`;
}

function sanitizeCloudInitValue(value: string | undefined): string {
  return String(value || "").replace(/[\r\n]/g, "").trim();
}

export class Provisioner {
  private hetzner: HetznerCloudClient;
  private companionImage: string;
  private hetznerSshKeyId?: string;
  private hetznerServerTypes: Record<Plan, string>;

  constructor(config: ProvisionerConfig) {
    this.hetzner = new HetznerCloudClient(config.hetznerToken);
    this.companionImage = config.companionImage;
    this.hetznerSshKeyId = config.hetznerSshKeyId;
    this.hetznerServerTypes = {
      starter: config.hetznerServerTypes?.starter || DEFAULT_SERVER_TYPE_CANDIDATES.starter[0],
      pro: config.hetznerServerTypes?.pro || DEFAULT_SERVER_TYPE_CANDIDATES.pro[0],
      enterprise: config.hetznerServerTypes?.enterprise || DEFAULT_SERVER_TYPE_CANDIDATES.enterprise[0],
    };
  }

  private getServerTypeCandidates(plan: Plan, region: string): string[] {
    const configured = this.hetznerServerTypes[plan];
    const normalizedRegion = region.trim().toLowerCase();
    const regionDefaults =
      normalizedRegion === "iad"
        ? [DEFAULT_SERVER_TYPE_CANDIDATES[plan][0]]
        : EUROPE_SERVER_TYPE_CANDIDATES[plan];

    return [configured, ...regionDefaults, ...DEFAULT_SERVER_TYPE_CANDIDATES[plan]].filter(
      (value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index,
    );
  }

  private mapRegionToHetznerLocation(region: string): string[] {
    const normalized = region.trim().toLowerCase();
    // Keep fallbacks inside the selected geography.
    if (normalized === "iad") return ["ash", "hil"];
    if (normalized === "cdg") return ["nbg1", "hel1", "fsn1"];
    if (normalized === "fra") return ["nbg1", "hel1", "fsn1"];
    if (normalized === "ams") return ["nbg1", "hel1", "fsn1"];
    return ["nbg1", "hel1", "fsn1"];
  }

  private isInvalidLocationError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("field 'location'") || message.includes("invalid input in field 'location'");
  }

  private isUnsupportedServerLocationError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("unsupported location for server type");
  }

  private isDeprecatedServerTypeError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("server type") && message.includes("deprecated");
  }

  private isServerLocationDisabledError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("server location disabled");
  }

  private isNotFoundError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("failed (404)") || message.includes(`"code": "not_found"`) || message.includes(`"code":"not_found"`);
  }

  private isVolumeStillAttachedError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("volume with ID") && message.includes("is still attached to a server");
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildHetznerUserData(input: ProvisionInput, bootstrap: BootstrapCredentials, volumeName: string): string {
    const loginUrl = sanitizeCloudInitValue(input.loginUrl);
    const bootstrapUrl = sanitizeCloudInitValue(bootstrap.url);
    const bootstrapToken = sanitizeCloudInitValue(bootstrap.token);
    // Only non-secret config lives in /etc/companion.env up front. The real
    // secrets (COMPANION_AUTH_TOKEN, ...) are appended by companion-run.sh
    // after it exchanges the one-time bootstrap token with the control plane.
    // user_data stays readable via the Hetzner API and the instance metadata
    // service for the server's whole life, so it must hold nothing reusable.
    const env = [
      `NODE_ENV=production`,
      `HOST=0.0.0.0`,
      `COMPANION_HOME=/data/companion`,
      `COMPANION_SESSION_DIR=/data/sessions`,
      `COMPANION_AUTH_ENABLED=0`,
      `COMPANION_LOGIN_URL=${loginUrl}`,
    ]
      .map((line) => `      ${line}`)
      .join("\n");

    return `#cloud-config
runcmd:
  - apt-get update
  - apt-get install -y docker.io curl
  - systemctl enable docker
  - systemctl start docker
  - mkdir -p /data
  - DEV=/dev/disk/by-id/scsi-0HC_Volume_${volumeName}
  - if [ -b "$DEV" ]; then blkid "$DEV" || mkfs.ext4 -F "$DEV"; fi
  - if [ -b "$DEV" ]; then mountpoint -q /data || mount "$DEV" /data; fi
  - if [ -b "$DEV" ]; then grep -q "$DEV /data " /etc/fstab || echo "$DEV /data ext4 defaults,nofail 0 2" >> /etc/fstab; fi
  - mkdir -p /data/companion /data/sessions
  - chown -R 10001:10001 /data
  - systemctl daemon-reload
  - systemctl enable companion.service
  - systemctl restart companion.service
write_files:
  - path: /etc/companion.env
    permissions: "0600"
    content: |
${env}
  - path: /etc/companion-bootstrap.env
    permissions: "0600"
    content: |
      COMPANION_BOOTSTRAP_URL=${bootstrapUrl}
      COMPANION_BOOTSTRAP_TOKEN=${bootstrapToken}
  - path: /usr/local/bin/companion-run.sh
    permissions: "0755"
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      # First boot only: exchange the one-time bootstrap token for secrets.
      if [ -f /etc/companion-bootstrap.env ]; then
        . /etc/companion-bootstrap.env
        TMP="$(mktemp /etc/companion-secrets.XXXXXX)"
        OK=0
        for _ in $(seq 1 30); do
          if curl -fsS --max-time 15 -X POST -H "Authorization: Bearer $COMPANION_BOOTSTRAP_TOKEN" "$COMPANION_BOOTSTRAP_URL" -o "$TMP"; then OK=1; break; fi
          sleep 10
        done
        if [ "$OK" != 1 ]; then rm -f "$TMP"; echo "companion bootstrap exchange failed" >&2; exit 1; fi
        grep -E '^[A-Z_][A-Z0-9_]*=' "$TMP" >> /etc/companion.env
        rm -f "$TMP" /etc/companion-bootstrap.env
      fi
      docker rm -f companion >/dev/null 2>&1 || true
      docker run -d --name companion --restart unless-stopped -p 80:3456 -v /data:/data --env-file /etc/companion.env ${this.companionImage}
  - path: /etc/systemd/system/companion.service
    permissions: "0644"
    content: |
      [Unit]
      Description=Companion Container
      After=docker.service network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=/usr/local/bin/companion-run.sh
      ExecStop=/usr/bin/docker stop companion

      [Install]
      WantedBy=multi-user.target
`;
  }

  private resourceLabels(input: ProvisionInput): Record<string, string> {
    return {
      app: RESOURCE_LABELS.app,
      "managed-by": RESOURCE_LABELS.managedBy,
      organization: input.organizationId,
      ...(input.instanceId ? { [INSTANCE_LABEL]: input.instanceId } : {}),
    };
  }

  /** Best-effort cleanup of a half-created attempt; failures are logged, never swallowed silently. */
  private async cleanupFailedAttempt(input: ProvisionInput, serverId: number | null, volumeId: number): Promise<void> {
    if (serverId !== null) {
      try {
        await this.hetzner.deleteServer(serverId);
        logEvent("info", "provision.cleanup.server_deleted", { instanceId: input.instanceId, serverId });
      } catch (err) {
        logEvent("error", "provision.cleanup.server_delete_failed", {
          instanceId: input.instanceId,
          organizationId: input.organizationId,
          serverId,
          error: errorMessage(err),
        });
      }
    }
    try {
      await this.hetzner.deleteVolume(volumeId);
      logEvent("info", "provision.cleanup.volume_deleted", { instanceId: input.instanceId, volumeId });
    } catch (err) {
      logEvent("error", "provision.cleanup.volume_delete_failed", {
        instanceId: input.instanceId,
        organizationId: input.organizationId,
        volumeId,
        error: errorMessage(err),
      });
    }
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const config = PLAN_CONFIGS[input.plan];
    const bootstrap = input.bootstrap;
    if (!bootstrap?.url || !bootstrap?.token) {
      throw new Error("Provisioner.provision requires bootstrap credentials (url + token)");
    }
    if (input.tailscaleAuthKey) {
      logEvent("warn", "provision.tailscale_key_ignored", {
        instanceId: input.instanceId,
        reason: "long-lived secrets are not embedded in user_data",
      });
    }
    const progress = input.onProgress ?? (() => {});
    const candidateLocations = this.mapRegionToHetznerLocation(input.region);
    const candidateServerTypes = this.getServerTypeCandidates(input.plan, input.region);
    const resourceSuffix = randomBytes(4).toString("hex");
    const volumeName = makeVolumeName(input.hostname || `${input.organizationId}-${Date.now()}`, resourceSuffix);
    const machineName = makeMachineName(input.hostname || `${input.organizationId}-${Date.now()}`, resourceSuffix);
    let lastError: unknown = null;

    for (const serverType of candidateServerTypes) {
      for (const location of candidateLocations) {
      progress("creating_volume", "Creating storage volume", "in_progress");
      let volume: Awaited<ReturnType<HetznerCloudClient["createVolume"]>> | null = null;
      try {
        volume = await this.hetzner.createVolume({
          name: volumeName,
          location,
          size: config.storage_gb,
          labels: this.resourceLabels(input),
        });
        progress("creating_volume", "Creating storage volume", "done");
      } catch (err) {
        if (this.isInvalidLocationError(err)) {
          lastError = err;
          continue;
        }
        throw err;
      }

      progress("creating_machine", "Creating server", "in_progress");
      let serverId: number | null = null;
      try {
        const response = await this.hetzner.createServer({
          name: machineName,
          server_type: serverType,
          location,
          image: "ubuntu-24.04",
          volumes: [volume.id],
          user_data: this.buildHetznerUserData(input, bootstrap, volume.name),
          ssh_keys: this.hetznerSshKeyId ? [this.hetznerSshKeyId] : undefined,
          labels: this.resourceLabels(input),
        });
        serverId = response.server.id;
        if (response.action?.id) {
          await this.hetzner.waitForAction(response.action.id, 120_000);
        }
        progress("creating_machine", "Creating server", "done");

        progress("waiting_start", "Waiting for server to start", "in_progress");
        const server = await this.hetzner.waitForServerStatus(serverId, "running", 120_000);
        progress("waiting_start", "Waiting for server to start", "done");

        return {
          providerMachineId: String(serverId),
          providerVolumeId: String(volume.id),
          hostname: input.hostname || server.public_net?.ipv4?.ip || "",
        };
      } catch (err) {
        await this.cleanupFailedAttempt(input, serverId, volume.id);
        if (
          this.isInvalidLocationError(err) ||
          this.isUnsupportedServerLocationError(err) ||
          this.isDeprecatedServerTypeError(err) ||
          this.isServerLocationDisabledError(err)
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    }

    throw lastError ?? new Error("Failed to provision instance in available Hetzner locations");
  }

  async deprovision(machineId: string, volumeId: string): Promise<void> {
    try {
      await this.hetzner.powerOff(machineId);
    } catch (err) {
      if (!this.isNotFoundError(err)) {
        // Instance may already be stopped or removed.
      }
    }
    try {
      await this.hetzner.deleteServer(machineId);
    } catch (err) {
      if (!this.isNotFoundError(err)) throw err;
    }

    let lastVolumeError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.hetzner.deleteVolume(volumeId);
        return;
      } catch (err) {
        if (this.isNotFoundError(err)) return;
        if (!this.isVolumeStillAttachedError(err) || attempt === 4) throw err;
        lastVolumeError = err;
        await this.wait(2_000);
      }
    }

    if (lastVolumeError) throw lastVolumeError;
  }

  async start(machineId: string): Promise<void> {
    const action = await this.hetzner.powerOn(machineId);
    if (action?.id) {
      await this.hetzner.waitForAction(action.id, 90_000);
    }
    await this.hetzner.waitForServerStatus(machineId, "running", 90_000);
  }

  async stop(machineId: string): Promise<void> {
    let action: Awaited<ReturnType<HetznerCloudClient["powerOff"]>> | undefined;
    try {
      action = await this.hetzner.powerOff(machineId);
    } catch (err) {
      if (this.isNotFoundError(err)) return;
      throw err;
    }
    if (action?.id) {
      await this.hetzner.waitForAction(action.id, 90_000);
    }
    try {
      await this.hetzner.waitForServerStatus(machineId, "off", 90_000);
    } catch (err) {
      if (this.isNotFoundError(err)) return;
      throw err;
    }
  }

  async getStatus(machineId: string): Promise<string> {
    const server = await this.hetzner.getServer(machineId);
    return server.status;
  }

  async resize(machineId: string, plan: Plan): Promise<void> {
    const offAction = await this.hetzner.powerOff(machineId);
    if (offAction?.id) {
      await this.hetzner.waitForAction(offAction.id, 90_000);
    }
    await this.hetzner.waitForServerStatus(machineId, "off", 90_000);

    const changeAction = await this.hetzner.changeType(machineId, this.hetznerServerTypes[plan]);
    if (changeAction?.id) {
      await this.hetzner.waitForAction(changeAction.id, 120_000);
    }

    const onAction = await this.hetzner.powerOn(machineId);
    if (onAction?.id) {
      await this.hetzner.waitForAction(onAction.id, 90_000);
    }
    await this.hetzner.waitForServerStatus(machineId, "running", 90_000);
  }
}
