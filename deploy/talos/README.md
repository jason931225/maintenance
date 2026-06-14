# Talos on Oracle Cloud Ampere A1 (arm64) — single node

Bring-your-own-image bootstrap of a one-node Talos cluster in **ap-chuncheon-1**,
sized for Always Free (`VM.Standard.A1.Flex`, 4 OCPU / 24 GB).

## 0. Account note (free-tier image import)

Importing a custom compute image requires a **Pay-As-You-Go** account. Upgrading
from a pure free account to PAYG stays **$0** as long as you only launch
Always-Free-eligible shapes. If you must stay on a non-upgraded account, use the
boot-volume workaround: launch a throwaway image, attach a second block volume,
`dd` the Talos raw image onto it, then boot the A1 from that volume.

## 1. Get the Talos arm64 image (Image Factory)

Pick a schematic at <https://factory.talos.dev> (vanilla is fine; add the
`siderolabs/qemu-guest-agent` extension if you want OCI agent integration), then
download the **oracle-arm64** disk for v1.13.4:

```sh
curl -LO https://factory.talos.dev/image/<schematic-id>/v1.13.4/oracle-arm64.qcow2
tar zcf talos-oracle-arm64.oci oracle-arm64.qcow2 image_metadata.json   # metadata in this dir
```

## 2. Import as an OCI custom image

```sh
# Upload talos-oracle-arm64.oci to an OCI bucket, then:
oci compute image import from-object \
  --compartment-id "$COMPARTMENT" \
  --namespace "$OS_NAMESPACE" --bucket-name "$BUCKET" \
  --name talos-oracle-arm64.oci \
  --display-name talos-1.13.4-arm64 \
  --launch-mode PARAVIRTUALIZED \
  --source-image-type QCOW2
```

## 3. Networking (VCN security list — ingress rules)

| Port | Source | Purpose |
|---|---|---|
| 50000/tcp | your admin IP | Talos API (`talosctl`) |
| 6443/tcp | your admin IP | Kubernetes API |
| 80,443/tcp | 0.0.0.0/0 | Traefik ingress (HTTP-01 + app traffic) |

## 4. Launch the instance

Create a `VM.Standard.A1.Flex` (4 OCPU / 24 GB) from the imported image with a
public IP. Note its public IP as `$NODE_IP`.

## 5. Generate config (with the single-node patch) and apply

```sh
talosctl gen config maintenance "https://$NODE_IP:6443" \
  --config-patch-control-plane @deploy/talos/controlplane.patch.yaml \
  --additional-sans "$NODE_IP" --output-dir ./_talos

# Confirm the install disk first (OCI boot volume is usually /dev/sda):
talosctl -n "$NODE_IP" disks --insecure

talosctl apply-config --insecure -n "$NODE_IP" --file ./_talos/controlplane.yaml
```

## 6. Bootstrap + kubeconfig

```sh
export TALOSCONFIG=./_talos/talosconfig
talosctl config endpoint "$NODE_IP"
talosctl config node "$NODE_IP"
talosctl bootstrap                      # run ONCE
talosctl health                         # wait for the node to converge
talosctl kubeconfig ./_talos/kubeconfig
export KUBECONFIG=./_talos/kubeconfig
kubectl get nodes                       # Ready (control-plane, schedulable)
```

Keep `_talos/` (it holds the cluster PKI + secrets) out of git and backed up
securely. Continue with Argo CD bootstrap in [`../README.md`](../README.md).

## Notes

- The patch sets `allowSchedulingOnControlPlanes: true` (single node runs
  workloads), OCI NTP (`169.254.169.254`), and host DNS. Validated with
  `talosctl validate --mode cloud`.
- Upgrades are API-driven and atomic (A/B): `talosctl upgrade --image
  factory.talos.dev/...:v<next>`; Kubernetes upgrades via `talosctl upgrade-k8s`.
- `image_metadata.json` in this directory carries the A1 launch options
  (UEFI_64, paravirtualized) the import needs.
