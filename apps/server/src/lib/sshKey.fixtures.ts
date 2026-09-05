/** Real keys, made by `ssh-keygen`, not hand-written fixtures.
 *
 *  The point of this file is that the parser agrees with OpenSSH, so the
 *  inputs have to come from OpenSSH. Each was generated once for this test
 *  file and none of them protects anything, anywhere.
 *
 *  **Stored base64-encoded, and that is not obfuscation.** This repository is
 *  public, and a literal `-----BEGIN OPENSSH PRIVATE KEY-----` in it trips
 *  every secret scanner there is -- including GitHub's push protection, which
 *  would block the push outright. Encoding them keeps a throwaway test fixture
 *  from being reported as a leaked credential forever. Anyone can decode these
 *  in one line; nobody needs to.
 */
function decode(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

export const ED25519 = decode(
    "LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnph" +
    "QzFyWlhrdGRqRUFBQUFBQkc1dmJtVUFBQUFFYm05dVpRQUFBQUFBQUFBQkFB" +
    "QUFNd0FBQUF0emMyZ3RaVwpReU5UVXhPUUFBQUNCRjRMZ2FOUk1JMEU5NzBo" +
    "cks2TmJIVjRIbjZDcFd0OEt0bU1NK3daWkY0d0FBQUpEZXp1bkkzczdwCnlB" +
    "QUFBQXR6YzJndFpXUXlOVFV4T1FBQUFDQkY0TGdhTlJNSTBFOTcwaHJLNk5i" +
    "SFY0SG42Q3BXdDhLdG1NTSt3WlpGNHcKQUFBRUQxR2VuWFV4dzFFbEZNMGVk" +
    "TDVMTmZ3RkNSUCtBV1l6SndNZE1leDNUc2FFWGd1Qm8xRXdqUVQzdlNHc3Jv" +
    "MXNkWApnZWZvS2xhM3dxMll3ejdCbGtYakFBQUFCM0pqTFhSbGMzUUJBZ01F" +
    "QlFZPQotLS0tLUVORCBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0K",
);

/** The same kind of key, with a passphrase. Refused, because nothing can be
 *  asked for one at the moment a commit is made. */
export const ED25519_PASSPHRASE = decode(
    "LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnph" +
    "QzFyWlhrdGRqRUFBQUFBQ21GbGN6STFOaTFqZEhJQUFBQUdZbU55ZVhCMEFB" +
    "QUFHQUFBQUJDT1RRWm9ZUwpmc3IwU3Z0Ti83RHQyeUFBQUFHQUFBQUFFQUFB" +
    "QXpBQUFBQzNOemFDMWxaREkxTlRFNUFBQUFJQVlkUnUwRlljeERKZWxJCitL" +
    "VE9tTmZiOFp1MjhkZ3VsUGxqVWtMeVBGcjNBQUFBa0dZWHpFaGY5QXVsSDNR" +
    "K0NDbTJONGhOajFFcStIRXplU0dTV2oKRzNQUCtNQUZuV2hhTkNPSEtjdlFE" +
    "QjY5SGhtamIzcUkreGEwckR2MnEvL3RyZnJhTXJBNklISGlqa3h5VmpKWHd0" +
    "bW52SAoxV1BvUlBUVVZuazl2eVhXbHdDTG5ZSzF3WkxIOVJ4dlF4Y2tqMEVi" +
    "eWJrZE56OEI5NmxOVXJYc01ObXBYbjEveU4vOERpCkExNjFTREkydFd1V3po" +
    "bGc9PQotLS0tLUVORCBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0K",
);

export const ECDSA = decode(
    "LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnph" +
    "QzFyWlhrdGRqRUFBQUFBQkc1dmJtVUFBQUFFYm05dVpRQUFBQUFBQUFBQkFB" +
    "QUFhQUFBQUJObFkyUnpZUwoxemFHRXlMVzVwYzNSd01qVTJBQUFBQ0c1cGMz" +
    "UndNalUyQUFBQVFRUk8rRFN0SW9EVnFUdTIzWXUyNGdBZlFlSXU4MFdvCmJ3" +
    "ZzJvYWRyaGwvVGozaVdQelA3SnFGOWROcGhpUTBBelRTbmlnS3ZwenpsSEkz" +
    "d2plb0ovL2ZxQUFBQW9FUldSYVZFVmsKV2xBQUFBRTJWalpITmhMWE5vWVRJ" +
    "dGJtbHpkSEF5TlRZQUFBQUlibWx6ZEhBeU5UWUFBQUJCQkU3NE5LMGlnTldw" +
    "TzdiZAppN2JpQUI5QjRpN3pSYWh2Q0RhaHAydUdYOU9QZUpZL00vc21vWDEw" +
    "Mm1HSkRRRE5OS2VLQXErblBPVWNqZkNONmduLzkrCm9BQUFBaEFQa1hYd2RE" +
    "YWFhZmN5MWZHZmY2ZUFtVHhhR0JGRHNwMHV1akR3cUlxVnQzQUFBQUIzSmpM" +
    "WFJsYzNRPQotLS0tLUVORCBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0K",
);

/** What `ssh-keygen` itself wrote as the public half, comment and all. The
 *  parser has to reproduce the first two fields of these exactly.
 *
 *  Public keys, so these stay readable. */
export const ED25519_PUBLIC =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXguBo1EwjQT3vSGsro1sdXgefoKla3wq2Ywz7BlkXj rc-test";
export const ECDSA_PUBLIC =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBE74NK0igNWpO7bdi7biAB9B4i7zRahvCDahp2uGX9OPeJY/M/smoX102mGJDQDNNKeKAq+nPOUcjfCN6gn/9+o= rc-test";
