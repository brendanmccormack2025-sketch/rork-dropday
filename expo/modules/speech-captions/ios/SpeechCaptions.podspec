Pod::Spec.new do |s|
  s.name           = 'SpeechCaptions'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech-to-text with word timings for local video files'
  s.description    = 'Extracts the audio to a temporary m4a and transcribes it with SFSpeechRecognizer, on-device only.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Speech', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
