import multer from 'multer';

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image uploads are allowed'));
  }
  cb(null, true);
}

export const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Media uploads for chat: allow images/videos/audio up to 50MB
function mediaFilter(req, file, cb) {
  if (!/^(image|video|audio)\//.test(file.mimetype)) {
    return cb(new Error('Only image/video/audio files are allowed'));
  }
  cb(null, true);
}

export const uploadMedia = multer({ storage, fileFilter: mediaFilter, limits: { fileSize: 50 * 1024 * 1024 } });
