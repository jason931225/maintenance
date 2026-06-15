# OpenTofu — OCI infrastructure for the FSM cluster

Declarative OCI infra (ap-chuncheon-1): VCN + hardened security list + public
subnet, two object-storage buckets (DB backups + evidence), a managed OCI
Bastion, the Talos node, and an Oracle Linux helper used to flash Talos.

Authenticates from `~/.oci/config` (API-key auth).

## Security hardening baked in

- **Control-plane APIs are not public.** Talos (`50000`) and Kubernetes (`6443`)
  ingress is restricted to `var.admin_cidr` + the VCN CIDR — never `0.0.0.0/0`.
  Only the app's `80/443` is world-open.
- **Managed OCI Bastion** for private-IP cluster access (port-forwarding
  sessions) instead of a public-IP jump host with open SSH.
- **No public SSH to the node** (Talos has no SSH). SSH `22` is admin-CIDR-only,
  for the helper.
- **ICMP type 3** allowed so PMTU discovery doesn't black-hole (the mTLS path).
- Buckets are `NoPublicAccess`; the backups bucket has versioning on.

## Usage

```sh
cd deploy/opentofu
cp terraform.tfvars.example terraform.tfvars   # fill in compartment, admin_cidr, ssh key
tofu init
tofu plan
tofu apply
```

`talos_image_ocid` is empty by default, so the first apply provisions
network + storage + bastion + the flasher helper. Import the Talos image and
flash the node per [`../talos/README.md`](../talos/README.md), then set
`talos_image_ocid` and re-apply to manage the node too.

## Adopting the already-live infra

The pilot infra was first stood up imperatively. To bring it under OpenTofu
without recreating it, `tofu import` each resource, e.g.:

```sh
tofu import oci_core_vcn.mnt              <vcn-ocid>
tofu import oci_core_internet_gateway.mnt <ig-ocid>
tofu import oci_core_route_table.mnt      <rt-ocid>
tofu import oci_core_security_list.mnt    <sl-ocid>
tofu import oci_core_subnet.mnt_public    <subnet-ocid>
tofu import oci_objectstorage_bucket.db_backups <namespace>/mnt-db-backups
tofu import oci_objectstorage_bucket.evidence    <namespace>/mnt-evidence
tofu import oci_bastion_bastion.mnt       <bastion-ocid>
tofu import oci_core_instance.flasher     <bastion-instance-ocid>
```

Then `tofu plan` — it should converge to the hardened security-list rules above
(the live list was opened more broadly during bootstrap; apply tightens it).
