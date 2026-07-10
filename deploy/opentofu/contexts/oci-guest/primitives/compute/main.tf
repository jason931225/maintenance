terraform {
  required_providers {
    oci = {
      source = "oracle/oci"
    }
  }
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment the OCI guest compute resources live in."
}

variable "availability_domain" {
  type        = string
  description = "Availability domain for the OCI guest instances."
}

variable "subnet_id" {
  type        = string
  description = "Public subnet ID for the flasher and optional Talos node."
}

variable "node_ocpus" {
  type        = number
  description = "OCPUs for the Ampere A1 instances."
}

variable "node_memory_gbs" {
  type        = number
  description = "Memory in GiB for the Ampere A1 instances."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key for the Oracle Linux flasher/helper host."
}

variable "talos_image_ocid" {
  type        = string
  description = "OCID of the bootable Talos arm64 image. Empty disables the Talos node."
}

variable "tags" {
  type        = map(string)
  description = "Freeform tags applied to OCI resources."
}

locals {
  shape = "VM.Standard.A1.Flex"
}

# Latest Oracle Linux 9 arm64 — used by the helper that flashes Talos onto the
# node's boot volume (the OCI qcow2 import path corrupts Talos's GPT, so Talos is
# written with `dd` from this helper; see ../talos/README.md).
data "oci_core_images" "oracle_linux" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Oracle Linux"
  operating_system_version = "9"
  shape                    = local.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# Helper / management host (also the OCI-Bastion alternative for cluster ops).
# Terminate it once the node is flashed + the cluster is reachable via the
# managed OCI Bastion.
resource "oci_core_instance" "flasher" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "mnt-bastion"
  shape               = local.shape

  shape_config {
    ocpus         = var.node_ocpus
    memory_in_gbs = var.node_memory_gbs
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.oracle_linux.images[0].id
  }

  create_vnic_details {
    subnet_id        = var.subnet_id
    assign_public_ip = true
  }

  metadata      = { ssh_authorized_keys = var.ssh_public_key }
  freeform_tags = var.tags
}

# The Talos control-plane node. Boots into maintenance mode from the image; the
# boot volume must carry Talos via the `dd` flash (see talos/README.md) for the
# OCI A1 to UEFI-boot it. Created only once a bootable image OCID is provided.
resource "oci_core_instance" "node" {
  count               = var.talos_image_ocid != "" ? 1 : 0
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "mnt-fsm-node"
  shape               = local.shape

  shape_config {
    ocpus         = var.node_ocpus
    memory_in_gbs = var.node_memory_gbs
  }

  source_details {
    source_type = "image"
    source_id   = var.talos_image_ocid
  }

  create_vnic_details {
    subnet_id        = var.subnet_id
    assign_public_ip = true
  }

  freeform_tags = var.tags

  # Talos has no SSH and is configured out of band via talosctl; ignore any
  # metadata/image drift so tofu doesn't try to rebuild the configured node.
  lifecycle {
    ignore_changes = [source_details, metadata]
  }
}

output "flasher_public_ip" {
  value = oci_core_instance.flasher.public_ip
}

output "node_public_ip" {
  value = try(oci_core_instance.node[0].public_ip, null)
}

output "flasher_instance_id" {
  value = oci_core_instance.flasher.id
}

output "node_instance_id" {
  value = try(oci_core_instance.node[0].id, null)
}
