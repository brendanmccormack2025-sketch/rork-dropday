Pod::Spec.new do |s|
  s.name           = 'AudioLoudness'
  s.version        = '1.0.0'
  s.summary        = 'On-device loudness-over-time reading for local video/audio files'
  s.description    = 'Reads the first audio track with AVAssetReader and returns RMS loudness (dBFS) per time window.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
