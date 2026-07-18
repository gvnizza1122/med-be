-- Processing Jobs Table (Track batch uploads)
CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id VARCHAR(255) UNIQUE NOT NULL,
  hospital_code VARCHAR(20) NOT NULL,
  uploaded_by UUID NOT NULL,

  -- File statistics
  total_files INT NOT NULL DEFAULT 0,
  processed_files INT DEFAULT 0,
  successful_files INT DEFAULT 0,
  failed_files INT DEFAULT 0,

  -- Status tracking
  status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed')),
  progress_percent INT DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  -- Error tracking
  error_message TEXT,
  error_details JSONB,

  -- Metadata
  upload_notes TEXT,
  metadata JSONB,

  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT valid_progress CHECK (progress_percent >= 0 AND progress_percent <= 100)
);

-- Index untuk faster lookups
CREATE INDEX IF NOT EXISTS idx_batch_id ON processing_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_status_progress ON processing_jobs(status, progress_percent);
CREATE INDEX IF NOT EXISTS idx_hospital_code ON processing_jobs(hospital_code, created_at);

-- Alter claim_files table to add batch relationship
ALTER TABLE claim_files ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE claim_files ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'pending' CHECK (review_status IN ('pending', 'in_review', 'reviewed', 'approved', 'rejected'));
ALTER TABLE claim_files ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE claim_files ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE claim_files ADD FOREIGN KEY (batch_id) REFERENCES processing_jobs(id) ON DELETE CASCADE;
ALTER TABLE claim_files ADD FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

-- Index untuk batch queries
CREATE INDEX IF NOT EXISTS idx_batch_files ON claim_files(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_review_status ON claim_files(review_status);
CREATE INDEX IF NOT EXISTS idx_created_with_status ON claim_files(created_at DESC, status);

-- Processing queue history (optional: for audit trail)
CREATE TABLE IF NOT EXISTS queue_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id VARCHAR(255),
  batch_id UUID NOT NULL,
  file_id UUID,
  event_type VARCHAR(50), -- 'queued', 'processing', 'completed', 'failed'
  status VARCHAR(50),
  message TEXT,
  error_details JSONB,
  duration_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES processing_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES claim_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_batch ON queue_history(batch_id);
CREATE INDEX IF NOT EXISTS idx_queue_file ON queue_history(file_id);
