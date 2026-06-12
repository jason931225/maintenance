package com.maintenance.field.data.offline

import java.security.SecureRandom

fun interface RequestIdFactory {
    fun nextId(): String
}

class UlidRequestIdFactory(
    private val random: SecureRandom = SecureRandom(),
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
) : RequestIdFactory {
    override fun nextId(): String {
        val chars = CharArray(26)
        var time = nowMillis()
        for (index in 9 downTo 0) {
            chars[index] = CROCKFORD[(time and 31).toInt()]
            time = time ushr 5
        }
        val randomBytes = ByteArray(10)
        random.nextBytes(randomBytes)
        var buffer = 0
        var bits = 0
        var out = 10
        for (byte in randomBytes) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5 && out < chars.size) {
                bits -= 5
                chars[out++] = CROCKFORD[(buffer shr bits) and 31]
            }
        }
        while (out < chars.size) {
            chars[out++] = CROCKFORD[random.nextInt(32)]
        }
        return String(chars)
    }

    private companion object {
        private val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray()
    }
}
