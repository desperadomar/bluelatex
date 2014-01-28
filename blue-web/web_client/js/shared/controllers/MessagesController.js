'use strict';

angular.module('bluelatex.Shared.Controllers.Messages', ['bluelatex.Shared.Services.Messages'])
  .controller('MessagesController', ['$rootScope', '$scope', 'MessagesService','$log',
    function ($rootScope, $scope, MessagesService, $log) {
      $scope.messages = MessagesService.messages;
      $scope.warnings = MessagesService.warnings;
      $scope.errors = MessagesService.errors;

      $scope.close = MessagesService.close;
    }
  ]);