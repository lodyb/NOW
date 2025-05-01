// Main Vue application
const app = Vue.createApp({
  data() {
    return {
      media: [],
      pendingUploads: [],
      searchQuery: '',
      loading: true,
      isDragging: false,
      isUploading: false,
      message: null,
      messageType: 'success',
      activeVideoUrl: null,
      mediaWithThumbnails: {}, // Track thumbnails for each media item
      currentThumbnailIndices: {} // Track current thumbnail index for each media
    };
  },
  
  mounted() {
    this.fetchMedia();
    this.connectToSSE();
  },
  
  methods: {
    connectToSSE() {
      const eventSource = new EventSource('/api/sse/media-status');
      
      // Handle SSE events
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        switch(data.type) {
          case 'mediaStatus':
            this.handleMediaStatusUpdate(data);
            break;
          case 'ping':
            // Just keep alive, no action needed
            break;
          case 'connected':
            console.log('SSE connection established');
            break;
          default:
            console.log('Unknown SSE event:', data);
        }
      };
      
      // Handle connection errors
      eventSource.onerror = () => {
        console.error('SSE connection error');
        this.showMessage('Lost connection to server, attempting to reconnect...', 'error');
        
        // Attempt to reconnect after a delay
        setTimeout(() => this.connectToSSE(), 5000);
      };
    },
    
    handleMediaStatusUpdate(data) {
      if (data.status === 'complete') {
        // Find and update the media item
        const mediaIndex = this.media.findIndex(item => item.id === data.mediaId);
        if (mediaIndex !== -1) {
          // Update the normalizedPath if provided
          if (data.normalizedPath) {
            this.media[mediaIndex].normalizedPath = data.normalizedPath;
          }
          this.showMessage(`Media processing complete: ${this.media[mediaIndex].title}`, 'success');
        } else {
          // If the item isn't in our list yet, refresh the list
          this.fetchMedia();
        }
      } else if (data.status === 'error') {
        this.showMessage(`Error processing media: ${data.message}`, 'error');
      }
    },
    
    async fetchMedia() {
      try {
        this.loading = this.media.length === 0; // Only show loading on initial fetch
        
        const params = {};
        if (this.searchQuery) {
          params.search = this.searchQuery;
        }
        
        const response = await axios.get('/api/media', { params });
        const newMedia = response.data;
        
        // Ensure sorting is maintained (newest first)
        newMedia.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        // Smart update: only update changed items
        if (this.media.length === 0) {
          // First load - set the whole array
          this.media = newMedia.map(this.prepareMediaItem);
        } else {
          // Update only changed items
          newMedia.forEach(newItem => {
            const existingIndex = this.media.findIndex(item => item.id === newItem.id);
            
            if (existingIndex === -1) {
              // New item - add to array
              this.media.push(this.prepareMediaItem(newItem));
            } else if (JSON.stringify(this.media[existingIndex]) !== JSON.stringify(newItem)) {
              // Item changed - preserve current thumbnail but update other props
              const currentThumbnail = this.media[existingIndex].currentThumbnail;
              this.media[existingIndex] = {
                ...this.prepareMediaItem(newItem),
                currentThumbnail
              };
            }
          });
          
          // Remove deleted items
          const newIds = new Set(newMedia.map(item => item.id));
          this.media = this.media.filter(item => newIds.has(item.id));
          
          // Re-sort to ensure consistency
          this.media.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }
        
        this.loading = false;
      } catch (error) {
        this.loading = false;
        this.showMessage('Error loading media: ' + (error.response?.data?.error || error.message), 'error');
      }
    },
    
    debounceSearch: _.debounce(function() {
      this.fetchMedia();
    }, 300),
    
    handleFileDrop(event) {
      this.isDragging = false;
      this.addFiles(Array.from(event.dataTransfer.files));
    },
    
    triggerFileInput() {
      this.$refs.fileInput.click();
    },
    
    handleFileChange(event) {
      this.addFiles(Array.from(event.target.files));
      // Reset the input to allow selecting the same file again
      this.$refs.fileInput.value = '';
    },
    
    addFiles(files) {
      const validFiles = files.filter(file => {
        const validTypes = [
          'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/x-flac',
          'video/mp4', 'video/webm', 'video/avi', 'video/quicktime', 'video/x-matroska',
          'video/x-ms-wmv'
        ];
        
        // Also check file extension if mimetype not recognized
        const ext = file.name.split('.').pop().toLowerCase();
        const validExtensions = ['mp3', 'ogg', 'wav', 'flac', 'mp4', 'webm', 'avi', 'mov', 'mkv', 'wmv'];
        
        return validTypes.includes(file.type) || validExtensions.includes(ext);
      });
      
      if (validFiles.length < files.length) {
        this.showMessage(`${files.length - validFiles.length} invalid files were ignored`, 'error');
      }
      
      // Add valid files to pending uploads
      validFiles.forEach(file => {
        this.pendingUploads.push({
          id: Date.now() + Math.random().toString(36).substring(2, 9),
          file,
          filename: file.name,
          isAudio: file.type.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'flac'].includes(file.name.split('.').pop().toLowerCase()),
          answers: file.name.split('.')[0].replace(/[-_]/g, ' '), // Use filename without extension as initial answer
          progress: 0,
          uploading: false,
          error: null
        });
      });
    },
    
    async uploadAllFiles() {
      if (this.isUploading) return;
      
      this.isUploading = true;
      let successCount = 0;
      let errorCount = 0;
      
      this.showMessage('Starting uploads...', 'success');
      
      // Process each upload sequentially to avoid race conditions
      for (const upload of [...this.pendingUploads]) { // Create a copy of the array to avoid modification issues
        if (upload.uploading) continue;
        
        upload.uploading = true;
        upload.error = null;
        
        try {
          const formData = new FormData();
          formData.append('file', upload.file);
          
          // Add answers if provided
          if (upload.answers && upload.answers.trim()) {
            formData.append('answers', upload.answers);
          }
          
          // Upload the file
          const response = await axios.post('/api/upload', formData, {
            onUploadProgress: (progressEvent) => {
              upload.progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            }
          });
          
          // Upload successful, now update answers if needed
          if (upload.answers && upload.answers.trim() && response.data.id) {
            await axios.put(`/api/media/${response.data.id}/answers`, {
              answers: upload.answers.split('\n').filter(a => a.trim())
            });
          }
          
          // Remove from pending uploads on success
          const index = this.pendingUploads.findIndex(u => u.id === upload.id);
          if (index !== -1) {
            this.pendingUploads.splice(index, 1);
          }
          successCount++;
        } catch (error) {
          upload.uploading = false;
          upload.error = error.response?.data?.error || error.message;
          errorCount++;
          console.error('Upload error:', error);
        }
      }
      
      // Refresh media list after all uploads
      await this.fetchMedia();
      this.isUploading = false;
      
      // Show appropriate toast based on results
      if (successCount > 0) {
        this.showMessage(`Successfully uploaded ${successCount} files${errorCount > 0 ? `, ${errorCount} failed` : ''}`, 
          errorCount > 0 ? 'warning' : 'success');
      } else if (errorCount > 0) {
        this.showMessage('All uploads failed. Please try again.', 'error');
      }
    },
    
    async uploadFile(upload) {
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', upload.file);
        
        // Create answers array from textarea (split by newline)
        const answers = upload.answers.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);
        
        // Include answers in the request
        formData.append('answers', JSON.stringify(answers));
        
        const xhr = new XMLHttpRequest();
        
        // Set up upload progress tracking
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const uploadIndex = this.pendingUploads.findIndex(item => item.id === upload.id);
            if (uploadIndex !== -1) {
              this.pendingUploads[uploadIndex].progress = Math.round((event.loaded / event.total) * 100);
            }
          }
        };
        
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            const uploadIndex = this.pendingUploads.findIndex(item => item.id === upload.id);
            
            if (xhr.status >= 200 && xhr.status < 300) {
              // Upload successful
              if (uploadIndex !== -1) {
                this.pendingUploads[uploadIndex].uploading = false;
                this.pendingUploads[uploadIndex].progress = 100;
              }
              
              try {
                const response = JSON.parse(xhr.responseText);
                resolve(response);
              } catch (e) {
                reject(new Error('Invalid response from server'));
              }
            } else {
              // Upload failed
              let errorMessage = 'Upload failed';
              
              try {
                const response = JSON.parse(xhr.responseText);
                errorMessage = response.error || errorMessage;
              } catch (e) {
                // If we can't parse the response, use status text
                errorMessage = xhr.statusText || errorMessage;
              }
              
              if (uploadIndex !== -1) {
                this.pendingUploads[uploadIndex].uploading = false;
                this.pendingUploads[uploadIndex].error = errorMessage;
              }
              
              reject(new Error(errorMessage));
            }
          }
        };
        
        // Mark as uploading
        const uploadIndex = this.pendingUploads.findIndex(item => item.id === upload.id);
        if (uploadIndex !== -1) {
          this.pendingUploads[uploadIndex].uploading = true;
          this.pendingUploads[uploadIndex].error = null;
        }
        
        // Start the upload
        xhr.open('POST', '/api/upload', true);
        xhr.send(formData);
      });
    },
    
    async saveAnswers(media) {
      try {
        const answers = media.answers.map(a => a.answer);
        
        await fetch(`/api/media/${media.id}/answers`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ answers })
        });
        
        this.showMessage('Answers saved successfully', 'success');
      } catch (error) {
        console.error('Error saving answers:', error);
        this.showMessage('Failed to save answers', 'error');
      }
    },
    
    async toggleMediaDeleted(media) {
      try {
        await fetch(`/api/media/${media.id}/toggle-deleted`, {
          method: 'POST'
        });
        
        // Update local state
        media.isDeleted = !media.isDeleted;
        
        this.showMessage(
          media.isDeleted ? 'Media marked as deleted' : 'Media restored',
          'success'
        );
      } catch (error) {
        console.error('Error toggling delete status:', error);
        this.showMessage('Failed to update media status', 'error');
      }
    },
    
    showMessage(text, type = 'success') {
      this.message = text;
      this.messageType = type;
      
      // Clear the message after 3 seconds
      setTimeout(() => {
        this.message = null;
      }, 3000);
    },
    
    isAudio(media) {
      if (!media.filePath) return false;
      const ext = media.filePath.split('.').pop().toLowerCase();
      return ['mp3', 'wav', 'ogg', 'flac'].includes(ext);
    },
    
    isVideo(media) {
      if (!media.filePath) return false;
      const ext = media.filePath.split('.').pop().toLowerCase();
      return ['mp4', 'webm', 'avi', 'mov', 'mkv', 'wmv'].includes(ext);
    },
    
    isProcessing(media) {
      return !media.normalizedPath;
    },
    
    getMediaUrl(media) {
      if (this.isProcessing(media)) return null;
      return `/media/normalized/${media.normalizedPath.split('/').pop()}`;
    },
    
    playVideo(media) {
      const mediaUrl = this.getMediaUrl(media);
      if (mediaUrl) {
        this.activeVideoUrl = mediaUrl;
      }
    },
    
    closeVideoModal() {
      this.activeVideoUrl = null;
    },
    
    hasThumbnails(item) {
      if (this.isAudio(item) && item.normalizedPath) {
        // Audio files should have waveform/spectrogram thumbs
        const baseFilename = item.normalizedPath.split('/').pop().replace(/\.[^/.]+$/, "");
        return baseFilename;
      }
      
      // For videos, check metadata
      return item.thumbnails && Array.isArray(item.thumbnails) && item.thumbnails.length > 0;
    },
    
    getThumbnails(item) {
      if (this.isAudio(item) && item.normalizedPath) {
        // For audio files, check for spectrogram and waveform images
        const baseFilename = item.normalizedPath.split('/').pop().replace(/\.[^/.]+$/, "");
        if (!baseFilename) return [];
        
        // Fixed audio thumbnails - use correct paths
        return [
          `${baseFilename}_waveform.png`,
          `${baseFilename}_spectrogram.png`
        ];
      }
      
      // For videos, use the video thumbnails if available
      return item.thumbnails && Array.isArray(item.thumbnails) ? item.thumbnails : [];
    },
    
    getCurrentThumbnailUrl(item) {
      const thumbnails = this.getThumbnails(item);
      if (!thumbnails.length) return '';
      
      const index = this.currentThumbnailIndices[item.id] || 0;
      const thumbnail = thumbnails[index];
      
      // Check if it's a full URL or just a filename
      if (thumbnail.startsWith('http')) {
        return thumbnail;
      }
      
      // Always use the thumbnails directory
      return `/thumbnails/${thumbnail}`;
    },
    
    nextThumbnail(media) {
      if (!this.hasThumbnails(media)) return;
      
      const thumbnails = this.getThumbnails(media);
      const currentIndex = this.currentThumbnailIndices[media.id] || 0;
      this.currentThumbnailIndices[media.id] = (currentIndex + 1) % thumbnails.length;
    },
    
    prevThumbnail(media) {
      if (!this.hasThumbnails(media)) return;
      
      const thumbnails = this.getThumbnails(media);
      const currentIndex = this.currentThumbnailIndices[media.id] || 0;
      this.currentThumbnailIndices[media.id] = (currentIndex - 1 + thumbnails.length) % thumbnails.length;
    },
    
    async generateThumbnails() {
      try {
        await fetch('/api/generate-thumbnails', {
          method: 'POST'
        });
        
        this.showMessage('Thumbnail generation started', 'success');
      } catch (error) {
        console.error('Error generating thumbnails:', error);
        this.showMessage('Failed to generate thumbnails', 'error');
      }
    },
    
    prepareMediaItem(item) {
      // Initialize the media item with thumbnails
      const processed = {
        ...item,
        // Use existing index if available, otherwise default to 0
        currentThumbnail: this.currentThumbnailIndices[item.id] || 0
      };
      
      // Extract thumbnails information
      if (this.isAudio(processed) && processed.normalizedPath) {
        // For audio files, set up waveform/spectrogram thumbnails
        const baseFilename = processed.normalizedPath.split('/').pop().replace(/\.[^/.]+$/, "");
        if (baseFilename) {
          processed.thumbnails = [
            `${baseFilename}_waveform.png`,
            `${baseFilename}_spectrogram.png`
          ];
        }
      } else if (this.isVideo(processed) && processed.normalizedPath) {
        // For video files, set up video thumbnails
        const baseFilename = processed.normalizedPath.split('/').pop().replace(/\.[^/.]+$/, "");
        if (baseFilename) {
          // Check metadata first, otherwise use default thumb pattern
          if (processed.metadata && processed.metadata.thumbnails) {
            processed.thumbnails = processed.metadata.thumbnails;
          } else {
            // Use standard naming pattern - create array with available thumbnails
            processed.thumbnails = [0, 1, 2].map(i => `${baseFilename}_thumb${i}.jpg`);
          }
        }
      }
      
      return processed;
    },

    updateThumbnailIndex(mediaId, index) {
      // Update the current thumbnail index for this media item
      this.currentThumbnailIndices[mediaId] = index;
    },
  }
});

// Media item component
app.component('media-item', {
  template: '#media-item-template',
  props: {
    media: Object,
    isProcessing: Boolean
  },
  
  data() {
    return {
      // Use the index set by parent component if available
      currentThumbnailIndex: this.media.currentThumbnail || 0
    };
  },
  
  computed: {
    isAudio() {
      if (!this.media.filePath) return false;
      const ext = this.media.filePath.split('.').pop().toLowerCase();
      return ['mp3', 'wav', 'ogg', 'flac'].includes(ext);
    },
    
    isVideo() {
      if (!this.media.filePath) return false;
      const ext = this.media.filePath.split('.').pop().toLowerCase();
      return ['mp4', 'webm', 'avi', 'mov', 'mkv', 'wmv'].includes(ext);
    },
    
    hasThumbnails() {
      if (this.isAudio && this.media.normalizedPath) {
        // For audio, check if we have waveform/spectrogram thumbnails
        const baseFilename = this.media.normalizedPath.split('/').pop();
        return !!baseFilename; // If we have a normalized path, assume thumbnails exist
      }
      
      // For videos, check for video thumbnails
      return this.thumbnails.length > 0;
    },
    
    thumbnails() {
      // If thumbnails were already initialized by the parent component
      if (this.media.thumbnails && Array.isArray(this.media.thumbnails)) {
        return this.media.thumbnails.map(t => {
          // Check if it's a full URL or just a filename
          return t.startsWith('http') ? t : `/thumbnails/${t}`;
        });
      }
      
      if (this.isAudio && this.media.normalizedPath) {
        // For audio files, generate waveform/spectrogram paths
        const baseFilename = this.media.normalizedPath.split('/').pop().replace(/\.[^/.]+$/, "");
        if (!baseFilename) return [];
        
        return [
          `/thumbnails/${baseFilename}_waveform.png`,
          `/thumbnails/${baseFilename}_spectrogram.png`
        ];
      }
      
      // For video files, use video thumbnails
      if (this.isVideo && this.media.normalizedPath) {
        const baseFilename = this.media.normalizedPath.split('/').pop().replace(/\.[^/.]+$/, "");
        
        // Check if there are thumbnails in metadata, otherwise generate standard paths
        if (this.media.metadata && this.media.metadata.thumbnails) {
          return this.media.metadata.thumbnails.map(t => `/thumbnails/${t}`);
        } else if (baseFilename) {
          // Generate standard thumbnail paths (thumb0.jpg, thumb1.jpg, thumb2.jpg)
          return [0, 1, 2].map(i => `/thumbnails/${baseFilename}_thumb${i}.jpg`);
        }
      }
      
      return [];
    },
    
    currentThumbnailUrl() {
      if (!this.hasThumbnails) return '';
      return this.thumbnails[this.currentThumbnailIndex];
    },
    
    thumbnailCount() {
      return this.thumbnails.length;
    }
  },
  
  methods: {
    playMedia() {
      if (this.media.normalizedPath) {
        const mediaUrl = `/media/normalized/${this.media.normalizedPath.split('/').pop()}`;
        if (this.isVideo) {
          // Emit event to show video modal
          this.$emit('playVideo', mediaUrl);
        } else {
          // Play audio directly
          const audio = new Audio(mediaUrl);
          audio.play();
        }
      }
    },
    
    nextThumbnail(event) {
      event.stopPropagation();
      if (this.thumbnailCount > 1) {
        this.currentThumbnailIndex = (this.currentThumbnailIndex + 1) % this.thumbnailCount;
        // Sync with parent component
        this.$emit('updateThumbnailIndex', this.media.id, this.currentThumbnailIndex);
      }
    },
    
    prevThumbnail(event) {
      event.stopPropagation();
      if (this.thumbnailCount > 1) {
        this.currentThumbnailIndex = (this.currentThumbnailIndex - 1 + this.thumbnailCount) % this.thumbnailCount;
        // Sync with parent component
        this.$emit('updateThumbnailIndex', this.media.id, this.currentThumbnailIndex);
      }
    },
    
    formatDate(dateString) {
      if (!dateString) return '';
      const date = new Date(dateString);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    },
    
    formatFileSize(bytes) {
      if (!bytes) return '';
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      if (bytes === 0) return '0 Bytes';
      const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10);
      return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
    },
    
    addAnswer() {
      this.media.answers.push({ answer: '', isPrimary: false });
    },
    
    removeAnswer(index) {
      this.media.answers.splice(index, 1);
      this.$emit('saveAnswers', this.media);
    }
  }
});

// Mount the Vue app
app.mount('#app');