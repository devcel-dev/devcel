//! Bounded stream framing with a 32-bit length header and continuation flag.
//! Large logical messages are a contiguous sequence of <=1MiB frames; the high
//! length bit denotes continuation. Frame and logical-message limits are enforced.
use std::io::{Error, ErrorKind, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
pub const MAX_FRAME_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
const CHUNK_BYTES: usize = 1024 * 1024;
const CONTINUATION: u32 = 1 << 31;

pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, data: &[u8]) -> Result<()> {
    if data.len() > MAX_MESSAGE_BYTES {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "P2P message exceeds 256MiB limit",
        ));
    }
    if data.len() <= MAX_FRAME_BYTES {
        writer.write_all(&(data.len() as u32).to_be_bytes()).await?;
        writer.write_all(data).await?;
    } else {
        let count = data.len().div_ceil(CHUNK_BYTES);
        for (index, chunk) in data.chunks(CHUNK_BYTES).enumerate() {
            let flag = if index + 1 < count { CONTINUATION } else { 0 };
            writer
                .write_all(&((chunk.len() as u32) | flag).to_be_bytes())
                .await?;
            writer.write_all(chunk).await?;
        }
    }
    Ok(())
}
pub(crate) struct ReceivedMessage {
    data: Vec<u8>,
    _memory: Vec<tokio::sync::OwnedSemaphorePermit>,
}
impl std::ops::Deref for ReceivedMessage {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.data
    }
}

pub async fn read_message<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    Ok(receive(reader, None, std::time::Duration::from_secs(10))
        .await?
        .map(|message| message.data))
}

pub(crate) async fn read_message_budgeted<R: AsyncRead + Unpin>(
    reader: &mut R,
    budget: &std::sync::Arc<tokio::sync::Semaphore>,
) -> Result<Option<ReceivedMessage>> {
    receive(reader, Some(budget), std::time::Duration::from_secs(10)).await
}

async fn receive<R: AsyncRead + Unpin>(
    reader: &mut R,
    budget: Option<&std::sync::Arc<tokio::sync::Semaphore>>,
    deadline: std::time::Duration,
) -> Result<Option<ReceivedMessage>> {
    let mut data = Vec::new();
    let mut memory = Vec::new();
    let mut frames = 0;
    loop {
        let mut header = [0u8; 4];
        // An idle authenticated watcher can wait indefinitely between messages.
        // Once any byte arrives, partial headers/bodies/continuations have deadlines.
        let first = if data.is_empty() {
            reader.read(&mut header[..1]).await?
        } else {
            tokio::time::timeout(deadline, reader.read(&mut header[..1]))
                .await
                .map_err(|_| Error::new(ErrorKind::TimedOut, "P2P continuation deadline"))??
        };
        if first == 0 {
            return if data.is_empty() {
                Ok(None)
            } else {
                Err(Error::new(
                    ErrorKind::UnexpectedEof,
                    "Truncated P2P message",
                ))
            };
        }
        tokio::time::timeout(deadline, reader.read_exact(&mut header[1..]))
            .await
            .map_err(|_| Error::new(ErrorKind::TimedOut, "P2P header deadline"))??;
        let size = u32::from_be_bytes(header);
        let continued = size & CONTINUATION != 0;
        let size = (size & !CONTINUATION) as usize;
        frames += 1;
        if size > MAX_FRAME_BYTES
            || (continued && size == 0)
            || size > MAX_MESSAGE_BYTES - data.len()
            || frames > 4096
        {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "P2P frame/message exceeds limit",
            ));
        }
        // Admission occurs before allocation and remains reserved while the
        // server decodes and executes this message, not just while reading it.
        if let Some(budget) = budget {
            memory.push(
                budget
                    .clone()
                    .try_acquire_many_owned(size as u32)
                    .map_err(|_| {
                        Error::new(ErrorKind::OutOfMemory, "P2P receive budget exhausted")
                    })?,
            );
        }
        let offset = data.len();
        data.resize(offset + size, 0);
        tokio::time::timeout(deadline, reader.read_exact(&mut data[offset..]))
            .await
            .map_err(|_| Error::new(ErrorKind::TimedOut, "P2P body deadline"))??;
        if !continued {
            return Ok(Some(ReceivedMessage {
                data,
                _memory: memory,
            }));
        }
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[tokio::test]
    async fn partial_header_and_body_expire_without_closing_idle_watchers() {
        for input in [vec![0], vec![0, 0, 0, 4, 1]] {
            let (mut writer, mut reader) = tokio::io::duplex(64);
            writer.write_all(&input).await.unwrap();
            let result = receive(&mut reader, None, std::time::Duration::from_millis(10)).await;
            assert_eq!(result.err().unwrap().kind(), ErrorKind::TimedOut);
        }
        let (_writer, mut reader) = tokio::io::duplex(64);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(30),
            receive(&mut reader, None, std::time::Duration::from_millis(10))
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn shared_budget_precedes_allocation_and_is_released_on_drop() {
        let budget = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
        let (mut writer, mut reader) = tokio::io::duplex(64);
        write_message(&mut writer, b"1234").await.unwrap();
        let message = read_message_budgeted(&mut reader, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(budget.available_permits(), 0);
        let (mut writer2, mut reader2) = tokio::io::duplex(64);
        write_message(&mut writer2, b"x").await.unwrap();
        assert_eq!(
            read_message_budgeted(&mut reader2, &budget)
                .await
                .err()
                .unwrap()
                .kind(),
            ErrorKind::OutOfMemory
        );
        drop(message);
        assert_eq!(budget.available_permits(), 4);
    }
}
