//! SFTP connection type.
//!
//! SFTP is a second connection type beside S3. Only one session is live at a
//! time, and both kinds share the session authority in `S3State`: the
//! backend-minted connection ID, the connection identity, the generation
//! counter, and the transfer registry. An SFTP session leaves the S3 client
//! empty, so every S3 command fails closed on it, and an S3 session leaves
//! `sftp` empty, so every SFTP command fails closed on it.

// The command bodies here are stubs until the connect, filesystem and transfer
// pieces land, so the helpers they will call are not yet reachable from a
// command. Remove this allow once every item has a caller.
#![allow(dead_code)]
// Commands are exposed through Tauri's `invoke` bridge, which marshals each
// parameter by name, so the flat signatures are intentional (see s3/mod.rs).
#![allow(clippy::too_many_arguments)]

pub(crate) mod connect;
pub(crate) mod fs;
pub(crate) mod keyfile;
pub(crate) mod path;
pub(crate) mod session;
pub(crate) mod transfer;
pub(crate) mod types;

pub(crate) use connect::*;
pub(crate) use fs::*;
pub(crate) use keyfile::*;
pub(crate) use session::SftpHandle;
pub(crate) use transfer::*;
