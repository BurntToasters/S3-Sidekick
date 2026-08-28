# Settings Glossary

| Setting | Meaning |
| --- | --- |
| Update channel | `Stable` follows published releases. `Beta` follows pre-release builds. |
| Transfer performance | `Safe` lowers memory and concurrency; `Balanced` is the default; `Max` favors throughput. |
| Bandwidth limit | Maximum aggregate transfer rate. Blank or unlimited uses available bandwidth. |
| Retry delay | Initial wait after a retryable failure. Later waits grow exponentially. |
| Parallel download threshold | Files at or above this size use range requests; smaller files use one request. |
| Download part size | Bytes in each parallel range. Larger parts use more memory and fewer requests. |
| Download concurrency | Number of ranges downloaded simultaneously for one file. |
| Upload part size | Bytes in each multipart upload part. Larger parts use more memory and fewer requests. |
| Upload concurrency | Number of multipart upload parts sent simultaneously. |
| Resume transfers | Stores encrypted checkpoint state for large interrupted downloads. |
| Checksum verification | Compares server-provided integrity checksums after transfers when available. |
| Checkpoint max age | How long unused resume checkpoints remain before cleanup. Active queued transfers are retained. |
| Pre-signed URL expiration | How long a generated share URL remains valid. |

Transfer status exposes progress, speed, ETA, retry phase, and checkpoint state in the Transfers panel. Checkpoints never override an object-generation mismatch.
