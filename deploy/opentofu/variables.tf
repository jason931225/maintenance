variable "compartment_ocid" {
  type        = string
  description = "Compartment the FSM infra lives in (the 'prod' compartment)."
}

variable "region" {
  type    = string
  default = "ap-chuncheon-1"
}

variable "availability_domain" {
  type    = string
  default = "Iyyn:AP-CHUNCHEON-1-AD-1"
}

# SECURITY: the Talos API (50000) and Kubernetes API (6443) are reachable ONLY
# from this CIDR (and the managed OCI Bastion / intra-VCN), never 0.0.0.0/0.
# Set it to your admin /32. Public app traffic (80/443) is open regardless.
variable "admin_cidr" {
  type        = string
  description = "Admin source CIDR allowed to reach the Talos + k8s control-plane APIs."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key for the (optional) bastion VM used to flash/manage Talos."
}

variable "vcn_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.0.0.0/24"
}

variable "node_ocpus" {
  type    = number
  default = 4
}

variable "node_memory_gbs" {
  type    = number
  default = 24
}

# Imported Talos custom image OCID. The Talos disk is written to the boot volume
# out of band (the OCI qcow2 import corrupts the GPT, so Talos is dd'd from a
# helper — see ../talos/README.md). Wiring the image here keeps the instance
# declarative once a bootable image exists.
variable "talos_image_ocid" {
  type        = string
  description = "OCID of the bootable Talos arm64 image (see deploy/talos/README.md)."
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = { project = "forklift-fsm", managed-by = "opentofu" }
}
