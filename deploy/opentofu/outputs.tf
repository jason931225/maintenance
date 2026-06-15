output "vcn_id" { value = oci_core_vcn.mnt.id }
output "subnet_id" { value = oci_core_subnet.mnt_public.id }
output "security_list_id" { value = oci_core_security_list.mnt.id }
output "bastion_ocid" { value = oci_bastion_bastion.mnt.id }
output "object_namespace" { value = data.oci_objectstorage_namespace.ns.namespace }

output "db_backups_bucket" { value = oci_objectstorage_bucket.db_backups.name }
output "evidence_bucket" { value = oci_objectstorage_bucket.evidence.name }

output "flasher_public_ip" {
  value       = oci_core_instance.flasher.public_ip
  description = "Helper/management host public IP (SSH as opc)."
}

output "node_public_ip" {
  value       = try(oci_core_instance.node[0].public_ip, null)
  description = "Talos node public IP (Traefik 80/443). Reserve it for stable DNS."
}
